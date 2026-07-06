// Package obs — CLI dual-output logger reference implementation.
//
// A COMPLETE, ZERO-DEPENDENCY reference you can drop into a Go service's
// `internal/obs` package. It gives a CLI process:
//
//   - a local run folder:            logs/<cmd>/<UTC-ts>-<run_id>/ (+ a `latest` symlink)
//   - a HUMAN-readable sink:         run.log   (aligned, colorized on a TTY)
//   - a MACHINE-readable sink:       run.jsonl (one JSON object per line, GCP-severity)
//   - console output on stderr       (INFO+ by default, DEBUG with Verbose)
//   - the full level range           TRACE, DEBUG, INFO, WARN, ERROR, FATAL
//   - run correlation                every line carries the same run_id
//   - a runtime-adjustable level      (console level is a *slog.LevelVar)
//   - a redaction BACKSTOP            denylisted keys are blanked at the handler
//
// It builds on log/slog with no third-party deps. The JSON sink renames the
// built-in level key to a top-level GCP `severity` (group-safe — built-in keys
// are never nested by WithGroup), matching the Cloud Logging shape used
// elsewhere in obs, so CLI runs and Cloud Run services parse identically.
//
// REDACTION IS A BACKSTOP, NOT A GUARANTEE. It blanks values whose key (or an
// enclosing group name) matches a denylist. It does NOT scan message text,
// error strings, URLs/DSNs, or opaque struct values. The real rule is upstream:
// never pass a secret, credential, auth header, or full request/response body
// to the logger in the first place. See redactKeys below and the skill's rule 7.
package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

// slog's built-ins: Debug=-4, Info=0, Warn=4, Error=8. We add the two ends
// operators actually ask for: TRACE (below DEBUG) and FATAL (above ERROR).
const (
	LevelTrace = slog.Level(-8)
	LevelDebug = slog.LevelDebug
	LevelInfo  = slog.LevelInfo
	LevelWarn  = slog.LevelWarn
	LevelError = slog.LevelError
	LevelFatal = slog.Level(12)
)

// levelString names a level. slog prints custom levels as "ERROR+4" unless named.
func levelString(l slog.Level) string {
	switch {
	case l <= LevelTrace:
		return "TRACE"
	case l < LevelInfo:
		return "DEBUG"
	case l < LevelWarn:
		return "INFO"
	case l < LevelError:
		return "WARN"
	case l < LevelFatal:
		return "ERROR"
	default:
		return "FATAL"
	}
}

// gcpSeverity maps a level to the value GCP Cloud Logging reads.
func gcpSeverity(l slog.Level) string {
	switch {
	case l < LevelInfo:
		return "DEBUG" // TRACE + DEBUG
	case l < LevelWarn:
		return "INFO"
	case l < LevelError:
		return "WARNING"
	case l < LevelFatal:
		return "ERROR"
	default:
		return "CRITICAL"
	}
}

// ---------------------------------------------------------------------------
// Redaction + sanitization — a backstop, applied structurally at the handler
// ---------------------------------------------------------------------------

// redactKeys are substrings that, if present in a leaf key OR an enclosing
// group name (case-insensitive), blank the value. This is a last line of
// defense, not a guarantee — it cannot see secrets inside message text, error
// strings, URLs, or opaque values. Don't rely on it; don't log the secret.
var redactKeys = []string{
	"token", "secret", "password", "passwd", "authorization", "auth",
	"api_key", "apikey", "cookie", "credential", "private_key", "access_key",
	"bearer", "session",
}

const redacted = "«redacted»"

// maxValueLen caps a single field's rendered length (defense against giant
// payloads and cardinality/disk blowups). Tune per service.
const maxValueLen = 4096

func sensitive(segments ...string) bool {
	for _, s := range segments {
		l := strings.ToLower(s)
		for _, deny := range redactKeys {
			if strings.Contains(l, deny) {
				return true
			}
		}
	}
	return false
}

// sanitizeMessage escapes control characters and newlines so a crafted message
// cannot forge extra log lines (log injection).
func sanitizeMessage(s string) string {
	if !strings.ContainsFunc(s, isControl) {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if isControl(r) {
				fmt.Fprintf(&b, `\x%02x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

// ---------------------------------------------------------------------------
// Fanout — one logger, many sinks, each with its own min level
// ---------------------------------------------------------------------------

type fanout struct{ handlers []slog.Handler }

func (f fanout) Enabled(ctx context.Context, l slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, l) {
			return true
		}
	}
	return false
}

func (f fanout) Handle(ctx context.Context, r slog.Record) error {
	var firstErr error
	for _, h := range f.handlers {
		if !h.Enabled(ctx, r.Level) {
			continue
		}
		// Clone: Record carries a shared backing array for attrs; handlers that
		// call AddAttrs would otherwise corrupt each other.
		if err := h.Handle(ctx, r.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (f fanout) WithAttrs(as []slog.Attr) slog.Handler {
	hs := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		hs[i] = h.WithAttrs(as)
	}
	return fanout{hs}
}

func (f fanout) WithGroup(name string) slog.Handler {
	hs := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		hs[i] = h.WithGroup(name)
	}
	return fanout{hs}
}

// ---------------------------------------------------------------------------
// Console handler — the human-readable sink
//   15:04:05.000 INFO  message here            key=value key="two words"
//
// slog group semantics are honored: attrs bound via WithAttrs are prefixed with
// the group path active AT BIND TIME (baked in immediately), so a later
// WithGroup cannot retroactively regroup them.
// ---------------------------------------------------------------------------

type kv struct{ k, v string }

type consoleHandler struct {
	mu     *sync.Mutex
	w      io.Writer
	level  slog.Leveler
	color  bool
	prefix string // current group path, e.g. "req.auth."
	baked  []kv   // attrs already prefixed + redacted + rendered
}

func newConsoleHandler(w io.Writer, level slog.Leveler, color bool) *consoleHandler {
	return &consoleHandler{mu: &sync.Mutex{}, w: w, level: level, color: color}
}

var levelColor = map[string]string{
	"TRACE": "\033[90m", "DEBUG": "\033[36m", "INFO": "\033[32m",
	"WARN": "\033[33m", "ERROR": "\033[31m", "FATAL": "\033[1;35m",
}

const colorReset = "\033[0m"

func (h *consoleHandler) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.level.Level()
}

func (h *consoleHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.WriteString(r.Time.Format("2006-01-02 15:04:05.000"))
	b.WriteByte(' ')

	lvl := levelString(r.Level)
	if h.color {
		b.WriteString(levelColor[lvl])
	}
	fmt.Fprintf(&b, "%-5s", lvl)
	if h.color {
		b.WriteString(colorReset)
	}
	b.WriteByte(' ')
	b.WriteString(sanitizeMessage(r.Message))

	// baked attrs (already prefixed at WithAttrs time) + record attrs (prefixed
	// with the CURRENT group path). Merge, sort for stable diffs, render.
	pairs := map[string]string{}
	for _, p := range h.baked {
		pairs[p.k] = p.v
	}
	r.Attrs(func(a slog.Attr) bool { renderAttr(pairs, h.prefix, a); return true })
	keys := make([]string, 0, len(pairs))
	for k := range pairs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "  %s=%s", k, pairs[k])
	}
	b.WriteByte('\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.w, b.String())
	return err
}

// renderAttr writes one attr (recursing into groups) into dst, applying the
// group prefix, redaction, truncation, and control-char-safe quoting.
func renderAttr(dst map[string]string, prefix string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Equal(slog.Attr{}) {
		return
	}
	key := prefix + a.Key
	if a.Value.Kind() == slog.KindGroup {
		g := a.Value.Group()
		if a.Key == "" { // inline group
			for _, ga := range g {
				renderAttr(dst, prefix, ga)
			}
			return
		}
		for _, ga := range g {
			renderAttr(dst, key+".", ga)
		}
		return
	}
	if sensitive(key) {
		dst[key] = redacted
		return
	}
	dst[key] = quoteValue(a.Value.String())
}

func quoteValue(s string) string {
	if utf8.RuneCountInString(s) > maxValueLen {
		s = truncate(s, maxValueLen)
	}
	if s == "" || strings.ContainsFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '"' || isControl(r)
	}) {
		return fmt.Sprintf("%q", s) // %q escapes controls + newlines
	}
	return s
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + fmt.Sprintf("…(+%d)", len(r)-n)
}

func (h *consoleHandler) WithAttrs(as []slog.Attr) slog.Handler {
	nc := *h
	nc.baked = append([]kv{}, h.baked...)
	tmp := map[string]string{}
	for _, a := range as {
		renderAttr(tmp, h.prefix, a) // bake with the CURRENT prefix
	}
	for k, v := range tmp {
		nc.baked = append(nc.baked, kv{k, v})
	}
	return &nc
}

func (h *consoleHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	nc := *h
	nc.prefix = h.prefix + name + "."
	return &nc
}

// ---------------------------------------------------------------------------
// Logger — slog wrapper adding Trace + Fatal and preserving the wrapper type
// ---------------------------------------------------------------------------

// Logger wraps *slog.Logger. Use the standard Debug/Info/Warn/Error plus the
// two extras below. All take alternating key/value pairs — never fmt.Sprintf
// into the message. The *Context variants thread a context.Context (for trace
// correlation / cancellation) through to the handler.
type Logger struct{ *slog.Logger }

func (l *Logger) Trace(msg string, kv ...any) {
	l.Logger.Log(context.Background(), LevelTrace, msg, kv...)
}
func (l *Logger) TraceContext(ctx context.Context, msg string, kv ...any) {
	l.Logger.Log(ctx, LevelTrace, msg, kv...)
}

// With / WithGroup return *Logger (not *slog.Logger) so Trace/Fatal survive.
func (l *Logger) With(kv ...any) *Logger      { return &Logger{l.Logger.With(kv...)} }
func (l *Logger) WithGroup(name string) *Logger { return &Logger{l.Logger.WithGroup(name)} }

// ---------------------------------------------------------------------------
// CLI bootstrap
// ---------------------------------------------------------------------------

// CLILogger is a Logger plus the run folder, its open files, and the live
// console-level control. Call Close() (defer it in main) to release the files.
type CLILogger struct {
	*Logger
	Dir          string
	RunID        string
	ConsoleLevel *slog.LevelVar // adjust at runtime, e.g. on SIGUSR1
	closers      []io.Closer
}

// Options configure NewCLI.
type Options struct {
	Root    string // base folder for run dirs (default "logs")
	Verbose bool   // lower the console threshold from INFO to DEBUG
	Service string // baked onto every line (GCP parity)
	Type    string
}

// NewCLI creates logs/<cmd>/<UTC-ts>-<run_id>/{run.log,run.jsonl}, wires a
// fanout over three sinks (stderr console, run.log human, run.jsonl machine),
// and returns a Logger whose every line carries a fresh run_id. Defer Close().
//
//	lg, err := obs.NewCLI("gws-sync", obs.Options{Service: "stark-admin", Type: "connector"})
//	if err != nil { return err }
//	defer lg.Close()
//	lg.Info("run started", "connector", "gws")
func NewCLI(cmd string, opt Options) (*CLILogger, error) {
	if opt.Root == "" {
		opt.Root = "logs"
	}
	runID, err := newRunID()
	if err != nil {
		return nil, err // never proceed without correlation
	}
	safeCmd := sanitizePathComponent(cmd)
	ts := time.Now().UTC().Format("20060102T150405Z")
	// run_id in the dir name makes same-second runs collision-free.
	dir := filepath.Join(opt.Root, safeCmd, ts+"-"+runID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create log dir %s: %w", dir, err)
	}

	// O_EXCL: refuse to follow/append a pre-existing file or symlink at the path.
	humanFile, err := openNew(filepath.Join(dir, "run.log"))
	if err != nil {
		return nil, fmt.Errorf("create run.log: %w", err)
	}
	jsonFile, err := openNew(filepath.Join(dir, "run.jsonl"))
	if err != nil {
		humanFile.Close()
		return nil, fmt.Errorf("create run.jsonl: %w", err)
	}

	// Best-effort atomic `latest` symlink: create-tmp + rename over the old one.
	updateLatestSymlink(filepath.Join(opt.Root, safeCmd), ts+"-"+runID)

	consoleLevel := new(slog.LevelVar)
	consoleLevel.Set(LevelInfo)
	if opt.Verbose {
		consoleLevel.Set(LevelDebug)
	}
	color := shouldColor(os.Stderr)

	jsonHandler := slog.NewJSONHandler(jsonFile, &slog.HandlerOptions{
		Level:       LevelTrace, // capture everything to the machine sink
		ReplaceAttr: jsonReplace,
	})

	h := fanout{handlers: []slog.Handler{
		newConsoleHandler(os.Stderr, consoleLevel, color),
		newConsoleHandler(humanFile, levelPtr(LevelTrace), false), // full detail, no color
		jsonHandler,
	}}

	base := slog.New(h)
	if opt.Service != "" {
		base = base.With("service", opt.Service)
	}
	if opt.Type != "" {
		base = base.With("type", opt.Type)
	}
	base = base.With("run_id", runID, "command", safeCmd)

	return &CLILogger{
		Logger:       &Logger{base},
		Dir:          dir,
		RunID:        runID,
		ConsoleLevel: consoleLevel,
		closers:      []io.Closer{humanFile, jsonFile},
	}, nil
}

// jsonReplace renders the GCP/obs shape and applies the redaction backstop.
// The built-in level key is renamed to a TOP-LEVEL `severity` — built-in keys
// are never nested by WithGroup, so this is group-safe (unlike a wrapping
// handler that AddAttrs-es severity, which would nest under an active group).
func jsonReplace(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 {
		switch a.Key {
		case slog.TimeKey:
			a.Key = "timestamp"
			return a
		case slog.MessageKey:
			a.Key = "message"
			a.Value = slog.StringValue(sanitizeMessage(a.Value.String()))
			return a
		case slog.LevelKey:
			lvl, ok := a.Value.Any().(slog.Level)
			if !ok {
				return a // never panic on an unexpected value
			}
			return slog.String("severity", gcpSeverity(lvl))
		case "severity": // reserve the top-level GCP key against user collisions
			a.Key = "severity_field"
		}
	}
	if sensitive(append(append([]string{}, groups...), a.Key)...) {
		return slog.String(a.Key, redacted)
	}
	return a
}

// Fatal logs at FATAL, flushes+closes the run files, then exits non-zero.
// Call only from main — os.Exit skips every other defer. The FATAL record is
// durable: os.File writes are unbuffered, so it reaches disk before Close.
func (c *CLILogger) Fatal(msg string, kv ...any) {
	c.Logger.Logger.Log(context.Background(), LevelFatal, msg, kv...)
	_ = c.Close()
	os.Exit(1)
}

// Close flushes and releases the run files. Do not log after Close.
func (c *CLILogger) Close() error {
	var firstErr error
	for _, cl := range c.closers {
		if err := cl.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// --- small helpers -------------------------------------------------------

func newRunID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate run id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func levelPtr(l slog.Level) *slog.LevelVar {
	v := new(slog.LevelVar)
	v.Set(l)
	return v
}

func openNew(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
}

func sanitizePathComponent(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			return r
		default:
			return '-'
		}
	}, s)
	s = strings.Trim(s, ".-")
	if s == "" {
		return "run"
	}
	return s
}

func updateLatestSymlink(dir, target string) {
	tmp := filepath.Join(dir, ".latest.tmp")
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return // best-effort; not fatal
	}
	_ = os.Rename(tmp, filepath.Join(dir, "latest")) // atomic replace
}

// shouldColor honors NO_COLOR and TERM=dumb, and only colors a real terminal.
func shouldColor(f *os.File) bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return false
	}
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
