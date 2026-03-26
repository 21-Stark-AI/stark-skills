# stark-tournament — Internals

Run multi-LLM tournaments: N competitors on the same task, evaluated by a judge, winner declared. Use when the user says "run a tournament", "compare LLMs", "which model is best for", "compete", or invokes /stark-tournament.

## Architecture

```mermaid

```

![A light, developer-focused architecture page for the stark-tournament skill, with a blue-green gradient overview panel, KPI tiles, a legend, and a vertical flowchart of four phases: parse and validate, dispatch tournament.py, optionally display JSON results, and report audit artifacts. Blue phase nodes, purple decision diamonds, green config nodes, amber output boxes, red failure recovery, and gray external dependencies explain data flow, while a contracts table and six detail cards cover scoring logic, strategies, extension points, failure isolation, observability, and audit storage."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-tournament/SKILL.md`, then run `/stark-generate-docs --skill stark-tournament` to regenerate documentation.
