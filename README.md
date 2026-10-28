# agent-board

A pane beside the chat that shows what every subagent is working on: in this session, and in every other Claude Code session that runs the plugin, on the PC or in the cloud.

Each row carries the agent's task description, its type (Explore, general-purpose, fork, and so on), how long it has run, how many tool calls it has made and the last one, and, once it finishes, the first line of its report. Sessions are grouped by working folder and host. A session that stops reporting for 2 minutes is marked stale. The status line shows "N agents running across M sessions".

## Install

```
/plugin install agent-board --marketplace roxanne-creator/agent-board
```

When asked for options, enter the gist id and the GitHub token (see Setup). Leave both empty to run single-session, with no network use at all.

## Setup (once)

1. Create a secret GitHub Gist with one file, `README.md`. Its id is the hex string in the gist URL.
2. Create a fine-grained personal access token with **Gists: Read and write** and nothing else.
3. Enter both at install, or later through `/config` (the token is stored by Claude Code in secure storage, never in a file).

## How it works

- Every session writes one file to the gist, `<session-id>.json`, within 2 seconds of any agent change, plus a heartbeat every 30 seconds while an agent runs (every 60 seconds otherwise). The file is deleted when the session ends.
- While the pane is open, each session reads the gist every 30 seconds and merges every file. The gist is the only shared store; nothing is written anywhere else.
- If GitHub is unreachable the pane keeps this session's rows, keeps the last copy of the others, and says since when. It retries on the next tick, never faster.
- `/agent-board` reopens the pane.

Budget: at idle with the pane open, about 60 writes and 120 reads per hour per session, well inside GitHub's 5,000 requests per hour per token.

## Development

`claude plugin validate .` checks the manifest and module; `claude plugin test .` runs the tests in `hooks/`.
