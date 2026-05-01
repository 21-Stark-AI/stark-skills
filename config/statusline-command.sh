#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette
# Input: JSON via stdin

input=$(cat)

# ── Extract all fields (single jq call) ──────────────────────────────────
eval "$(jq -r <<<"$input" '{
  cwd:          (.workspace.current_dir // .cwd // ""),
  model:        (.model.display_name // ""),
  model_id:     (.model.id // ""),
  used_pct:     (.context_window.used_percentage // ""),
  ctx_size:     (.context_window.context_window_size // ""),
  vim_mode:     (.vim.mode // ""),
  session_name: (.session_name // ""),
  session_id:   (.session_id // ""),
  week_pct:     (.rate_limits.seven_day.used_percentage // ""),
  week_reset:   (.rate_limits.seven_day.resets_at // ""),
  five_pct:     (.rate_limits.five_hour.used_percentage // ""),
  five_reset:   (.rate_limits.five_hour.resets_at // ""),
  tokens_in:    (.context_window.total_input_tokens // ""),
  tokens_out:   (.context_window.total_output_tokens // ""),
  cur_in:       (.context_window.current_usage.input_tokens // ""),
  cur_out:      (.context_window.current_usage.output_tokens // ""),
  cur_cw:       (.context_window.current_usage.cache_creation_input_tokens // ""),
  cur_cr:       (.context_window.current_usage.cache_read_input_tokens // ""),
  cost_usd:     (.cost.total_cost_usd // ""),
  over_200k:    (.exceeds_200k_tokens // false),
  s_added:      (.cost.total_lines_added // ""),
  s_removed:    (.cost.total_lines_removed // ""),
  total_dur_ms: (.cost.total_duration_ms // ""),
  api_dur_ms:   (.cost.total_api_duration_ms // "")
} | to_entries[] | "\(.key)=\(.value | tostring | @sh)"')"

# ── Colors (Catppuccin Mocha 256-color) ──────────────────────────────────
R="\033[0m" DIM="\033[38;5;245m"
PEACH="\033[38;5;216m" YEL="\033[38;5;229m" GRN="\033[38;5;150m"
SAP="\033[38;5;117m"   RED="\033[38;5;211m" TEAL="\033[38;5;158m"
MAR="\033[38;5;217m"   MAUVE="\033[38;5;141m" SKY="\033[38;5;117m"
SEP=" ${DIM}|${R} "

# ── Segment visibility (from statusline-setup.py config) ────────────────
# Single jq pass replaces a 3-fork grep|cut|tr chain.
_skip=""
_cfg="$HOME/.claude/statusline-segments.json"
[ -f "$_cfg" ] && _skip=" $(jq -r '[to_entries[] | select(.value == false) | .key] | join(" ")' "$_cfg" 2>/dev/null) "
_on() { [[ "$_skip" != *" $1 "* ]]; }

# Cache wall-clock once; bash printf-builtin avoids a `date +%s` fork on
# each call site (rate segs, last-tool freshness, session-start).
printf -v NOW '%(%s)T' -1

# ── Helpers ──────────────────────────────────────────────────────────────
seg()  { [ -z "$out" ] && out="$1" || out="${out}${SEP}$1"; }      # line 1 append
seg2() { [ -z "$l2" ] && l2="$1" || l2="${l2}${SEP}$1"; }         # line 2 append

tcolor() { # val hi_thresh mid_thresh → stdout color escape
  if [ "$1" -ge "$2" ] 2>/dev/null; then echo "$RED"
  elif [ "$1" -ge "$3" ] 2>/dev/null; then echo "$YEL"
  else echo "$DIM"; fi
}

fmt_dur() { # seconds → "Xh Ym" | "Xm" | "Xs"
  local h=$(( $1 / 3600 )) m=$(( ($1 % 3600) / 60 ))
  if [ "$h" -gt 0 ]; then echo "${h}h${m}m"
  elif [ "$m" -gt 0 ]; then echo "${m}m"
  else echo "${1}s"; fi
}

fmt_n() { # token count → "1.2k" / "145k" / "1.5M" — pure bash, no fork
  local n=${1:-0}
  if [ "$n" -ge 1000000 ] 2>/dev/null; then
    printf '%d.%dM' $((n / 1000000)) $(( (n % 1000000) / 100000 ))
  elif [ "$n" -ge 1000 ] 2>/dev/null; then
    printf '%d.%dk' $((n / 1000)) $(( (n % 1000) / 100 ))
  else
    printf '%d' "$n"
  fi
}

fmt_remain() { # reset_epoch [time_emoji] → " ⏳ Xd Yh" or empty
  [ -z "$1" ] || ! [ "$1" -gt 0 ] 2>/dev/null && return
  local diff=$(( $1 - NOW )) e="${2:-\\u23f3}"
  [ "$diff" -le 0 ] && return
  local d=$(( diff / 86400 )) h=$(( (diff % 86400) / 3600 )) m=$(( (diff % 3600) / 60 ))
  if [ "$d" -gt 0 ]; then echo " ${e} ${d}d${h}h"
  elif [ "$h" -gt 0 ]; then echo " ${e} ${h}h${m}m"
  else echo " ${e} ${m}m"; fi
}

rate_seg() { # section_emoji pct reset_epoch [time_emoji]
  [ -z "$2" ] && return
  local pct=$(printf "%.0f" "$2")
  seg2 "$(tcolor "$pct" 80 50)${1} ${pct}%$(fmt_remain "$3" "$4")${R}"
}

# ── Git (consolidated calls) ─────────────────────────────────────────────
wt_name="" repo_name="" git_branch="" git_dirty=""
if [ -n "$cwd" ]; then
  # Worktree + branch: single rev-parse
  { read -r gc; read -r gd; read -r git_branch; } \
    < <(git -C "$cwd" --no-optional-locks rev-parse --git-common-dir --git-dir --abbrev-ref HEAD 2>/dev/null)
  [ -n "$gc" ] && [ -n "$gd" ] && [ "$gc" != "$gd" ] && wt_name=${cwd##*/}

  remote=$(git -C "$cwd" --no-optional-locks remote get-url origin 2>/dev/null)
  if [ -n "$remote" ]; then repo_name=${remote##*/}; repo_name=${repo_name%.git}; fi

  if [ -n "$git_branch" ]; then
    # File counts: single porcelain call replaces diff + diff --cached + ls-files
    changed=0 untracked=0
    while IFS= read -r line; do
      x=${line:0:1} y=${line:1:1}
      if [ "$x" = "?" ]; then (( untracked++ ))
      else [ "$x" != " " ] && (( changed++ )); [ "$y" != " " ] && (( changed++ )); fi
    done < <(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)

    # `git diff HEAD --numstat` covers both unstaged and staged in one call
    # (single fork instead of `diff` + `diff --cached`). Sum in pure bash.
    la=0 lr=0
    while read -r added removed _; do
      [[ "$added" =~ ^[0-9]+$ ]] && la=$((la + added))
      [[ "$removed" =~ ^[0-9]+$ ]] && lr=$((lr + removed))
    done < <(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null)

    p=""
    [ "$changed" -gt 0 ]   && p="\U0001f4c4 ${changed}"
    [ "$untracked" -gt 0 ] && { [ -n "$p" ] && p="${p} "; p="${p}\U0001f50e ${untracked}"; }
    dp=""
    [ "$la" -gt 0 ] && dp="${GRN}+${la}${R}"
    [ "$lr" -gt 0 ] && { [ -n "$dp" ] && dp="${dp} "; dp="${dp}${RED}-${lr}${R}"; }
    [ -n "$dp" ] && { [ -n "$p" ] && p="${p} "; p="${p}${dp}"; }
    git_dirty="$p"
  fi
fi

# ── Context trend + cost formatting ─────────────────────────────────────
ctx_trend=""
if [ -n "$used_pct" ]; then
  ctx_trend=$("$HOME/.claude/statusline-ctx-trend.ts" "$used_pct" 2>/dev/null)
fi

# cost.total_cost_usd is computed correctly client-side by Claude Code,
# accounting for cache reads (10%), cache writes (1.25x/2x), and tier
# pricing (Opus 4 1M context >200K = 2x). Use it directly.
# Single awk emits cost + per-hour burn rate, tab-separated, in one fork.
session_cost="" cost_rate=""
if [ -n "$cost_usd" ]; then
  IFS=$'\t' read -r session_cost cost_rate < <(awk -v c="$cost_usd" -v d="${total_dur_ms:-0}" 'BEGIN{
    if (c+0 == 0) { print "\t"; exit }
    if (c < 0.01)    printf "%.2f\xc2\xa2", c*100
    else if (c < 1)  printf "$%.3f", c
    else             printf "$%.2f", c
    printf "\t"
    if (d+0 > 60000) {
      r = c * 3600000 / d
      if (r >= 10) printf "$%.1f/h", r
      else         printf "$%.2f/h", r
    }
  }')
fi

# ── File-based state ─────────────────────────────────────────────────────
last_tool="" lt_ts="" inflight=0 longest_tool="" longest_s=0

f="$HOME/.stark-insights/last-tool"
if [ -f "$f" ]; then
  IFS=$'\t' read -r lt_name lt_ms lt_ts < "$f" 2>/dev/null
  if [ -n "$lt_name" ] && [ -n "$lt_ms" ] && [ -n "$lt_ts" ] && [ $(( NOW - lt_ts )) -lt 30 ]; then
    [ "$lt_ms" -lt 1000 ] 2>/dev/null && last_tool="${lt_name} ${lt_ms}ms" || last_tool="${lt_name} $(( lt_ms / 1000 ))s"
  fi
fi

# Status file is single-line tab-separated key=value pairs. Read once, no
# nested while/for needed (the previous form ran an outer loop one time).
f="$HOME/.stark-insights/status"
if [ -f "$f" ]; then
  IFS=$'\t' read -ra flds < "$f" 2>/dev/null
  for x in "${flds[@]}"; do
    case "$x" in
      inflight=*)     inflight=${x#*=};;
      longest_tool=*) longest_tool=${x#*=};;
      longest_s=*)    longest_s=${x#*=};;
    esac
  done
fi

# Single sqlite3 fork instead of two — both counts in one query.
q_pending=0 q_dead=0
f="$HOME/.stark-insights/queue.db"
if [ -f "$f" ]; then
  IFS='|' read -r q_pending q_dead < <(sqlite3 "$f" \
    "SELECT (SELECT COUNT(*) FROM pending), (SELECT COUNT(*) FROM dead_letter)" 2>/dev/null)
  q_pending=${q_pending:-0} q_dead=${q_dead:-0}
fi

session_start=""
if [ -n "$session_id" ]; then
  f="$HOME/.stark-insights/session-start-${session_id}"
  [ ! -f "$f" ] && printf '%s\n' "$NOW" > "$f" 2>/dev/null
  read -r ts < "$f" 2>/dev/null
  [ -n "$ts" ] && printf -v session_start '%(%H:%M)T' "$ts" 2>/dev/null
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 1: repo · branch · model · operational
# ═════════════════════════════════════════════════════════════════════════
out=""
if _on repo_name && [ -n "$repo_name" ]; then
  out="${MAUVE}\U0001f5c2\ufe0f ${repo_name}${R}"
else
  out="${YEL}${cwd##*/}${R}"
fi
_on wt_name && [ -n "$wt_name" ] && seg "${TEAL}\U0001f332 ${wt_name}${R}"

if _on git_branch && [ -n "$git_branch" ]; then
  seg "${GRN}\u2618\ufe0f ${git_branch}${R}"
  _on git_dirty && [ -n "$git_dirty" ] && out="${out} ${MAR}${git_dirty}${R}"
fi

_on model && [ -n "$model" ] && seg "${SAP}$(sed -E 's/ [0-9]+\.[0-9]+//; s/ \(([0-9]+[KMG]) context\)/ \1/' <<<"$model")${R}"
_on inflight && [ "$inflight" -gt 0 ] 2>/dev/null && seg "${SKY}\u26a1\ufe0f ${inflight}${R}"
_on longest_tool && [ "$longest_s" -gt 60 ] 2>/dev/null && seg "$(tcolor "$longest_s" 180 60)\u23f3 ${longest_tool} $(( longest_s / 60 ))m${R}"
_on last_tool && [ -n "$last_tool" ] && seg "${TEAL}\u23f1\ufe0f ${last_tool}${R}"
_on q_pending && [ "$q_pending" -gt 5 ] 2>/dev/null && seg "${MAR}\U0001fab2 ${q_pending}${R}"
_on q_dead && [ "$q_dead" -gt 0 ] 2>/dev/null && seg "${RED}\U0001f41e ${q_dead}${R}"
_on session_name && [ -n "$session_name" ] && seg "${DIM}${session_name}${R}"
_on vim_mode && [ -n "$vim_mode" ] && { [ "$vim_mode" = "NORMAL" ] && seg "${YEL}N${R}" || seg "${DIM}I${R}"; }
_on session_start && [ -n "$session_start" ] && seg "\U0001f182 ${RED}${session_start}${R}"

if _on api_ratio && [ -n "$total_dur_ms" ] && [ -n "$api_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null; then
  ratio=$(( api_dur_ms * 100 / total_dur_ms ))
  seg "$(tcolor "$ratio" 80 50)\u2699\ufe0f ${ratio}%${R}"
fi

if _on end_time && [ -n "$lt_ts" ] && [ "$lt_ts" -gt 0 ] 2>/dev/null; then
  printf -v _et '%(%H:%M)T' "$lt_ts" 2>/dev/null || printf -v _et '%(%H:%M)T' -1
  seg "\U0001f174 ${GRN}${_et}${R}"
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 2: gauges · tokens · cost
# ═════════════════════════════════════════════════════════════════════════
l2=""

if _on ctx_usage && [ -n "$used_pct" ]; then
  ctx=$(printf "%.0f" "$used_pct"); c=$(tcolor "$ctx" 80 50)
  s="${c}\U0001f3ac ${ctx}%${R}"
  if [ -n "$ctx_trend" ]; then
    tc=$YEL; [ "$ctx" -ge 80 ] 2>/dev/null && tc=$RED
    s="${s}${tc}${ctx_trend}${R}"
  fi
  seg2 "$s"
fi

_on session_dur && [ -n "$total_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null && \
  seg2 "${DIM}\U0001faab $(fmt_dur $(( total_dur_ms / 1000 )))${R}"

_on five_hour_rl && rate_seg "\U0001f6dd" "$five_pct" "$five_reset" "\\u23f3"
_on weekly_rl && rate_seg "\U0001f4c5" "$week_pct" "$week_reset" "\\U0001f570\\ufe0f"

# Per-turn token breakdown from current_usage (last API call):
#   fresh = input_tokens + cache_creation_input_tokens — wire bytes sent as
#           new content (full price + cache-write surcharge).
#   read  = cache_read_input_tokens — referenced from cache (10% price).
#   out   = output_tokens — generated.
# Cache hit % = read / (fresh + read) — high = efficient session.
if _on tokens && [ -n "$cur_in" ]; then
  cin=${cur_in:-0} ccw=${cur_cw:-0} ccr=${cur_cr:-0} cot=${cur_out:-0}
  fresh=$(( cin + ccw ))
  total_in=$(( fresh + ccr ))
  hit=0
  [ "$total_in" -gt 0 ] && hit=$(( ccr * 100 / total_in ))
  tok="${SAP}\u2b06 $(fmt_n $fresh)${R}"
  [ "$ccr" -gt 0 ] && tok="${tok} ${GRN}\U0001f4d6 $(fmt_n $ccr)${DIM} ${hit}%${R}"
  [ "$cot" -gt 0 ] && tok="${tok} ${PEACH}\u2b07 $(fmt_n $cot)${R}"
  seg2 "$tok"
fi

# "How much of context is being read each turn" — total per-turn input vs
# context window size. When this stays high while ctx_usage is flat, you're
# paying to re-process a lot of cached context every turn.
if _on ctx_per_turn && [ -n "$cur_in" ] && [ -n "$ctx_size" ] && [ "$ctx_size" -gt 0 ] 2>/dev/null; then
  pt=$(( ${cur_in:-0} + ${cur_cw:-0} + ${cur_cr:-0} ))
  if [ "$pt" -gt 0 ]; then
    ptp=$(( pt * 100 / ctx_size ))
    seg2 "$(tcolor "$ptp" 80 50)\U0001f9e0 $(fmt_n $pt)/turn ${ptp}%${R}"
  fi
fi

# Cumulative session tokens — opt-in (off by default; can mislead because
# every API call's full input is summed, including cache rereads).
if _on tokens_total && { [ -n "$tokens_in" ] || [ -n "$tokens_out" ]; }; then
  tok=""
  [ -n "$tokens_in" ]  && tok="${DIM}\u03a3\u2b06 $(fmt_n ${tokens_in:-0})${R}"
  [ -n "$tokens_out" ] && tok="${tok} ${DIM}\u03a3\u2b07 $(fmt_n ${tokens_out:-0})${R}"
  seg2 "$tok"
fi

_on cost && [ -n "$session_cost" ] && seg2 "${PEACH}\U0001f4b0 ${session_cost}${R}"
_on cost_rate && [ -n "$cost_rate" ] && seg2 "${DIM}${cost_rate}${R}"
_on tier_warn && [ "$over_200k" = "true" ] && seg2 "${RED}\u26a0\ufe0f 1M-tier${R}"

if _on code_churn; then
  churn=""
  [ -n "$s_added" ]  && [ "$s_added" -gt 0 ]  2>/dev/null && churn="${GRN}+${s_added}${R}"
  [ -n "$s_removed" ] && [ "$s_removed" -gt 0 ] 2>/dev/null && { [ -n "$churn" ] && churn="${churn} "; churn="${churn}${RED}-${s_removed}${R}"; }
  [ -n "$churn" ] && seg2 "\u270f\ufe0f ${churn}"
fi

printf "%b\n" "${out}\n${l2}"
