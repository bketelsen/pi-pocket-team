# Bench stage 1

Models: 10. Tasks: 36 usable of 36.

| Band | Tasks |
| --- | --- |
| easy | 15 |
| medium | 14 |
| hard | 5 |
| unsolved | 2 |

## easy: 15 tasks, B1 github-copilot/claude-opus-5.5, shortlist github-copilot/gpt-6-luna, deepseek/deepseek-flash

| Model | Passes | Mean grade | Cost per pass | Availability | Median wall s | P(gap <= margin) vs B1 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek/deepseek-flash | 15 | 3.53 | 0.05 | 1.00 | 386 | 0.925 |
| github-copilot/claude-haiku-5.5 | 13 | 3.37 | 0.08 | 1.00 | 246 | 0.503 |
| github-copilot/claude-opus-5.5 | 15 | 3.73 | 0.54 | 1.00 | 265 | 0.925 |
| github-copilot/claude-sonnet-5.5 | 15 | 3.60 | 0.16 | 1.00 | 106 | 0.925 |
| github-copilot/gemini-3.8-flash | 8 | 2.27 | 5.95 | 1.00 | 1020 | 0.022 |
| github-copilot/gpt-6-luna | 14 | 3.23 | 0.02 | 1.00 | 188 | 0.737 |
| github-copilot/gpt-6.1-sol | 13 | 3.43 | 0.20 | 1.00 | 216 | 0.503 |
| github-copilot/grok-4.7 | 14 | 3.43 | 2.45 | 1.00 | 811 | 0.737 |
| github-copilot/mai-code-2-flash | 10 | 3.00 | 0.44 | 1.00 | 246 | 0.086 |
| halogen/halogen-qwen3.8-flash-next | 11 | 2.83 | 0.88 | 1.00 | 569 | 0.163 |

## medium: 14 tasks, B1 github-copilot/claude-opus-5.5, shortlist -

| Model | Passes | Mean grade | Cost per pass | Availability | Median wall s | P(gap <= margin) vs B1 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek/deepseek-flash | 5 | 2.11 | 0.25 | 1.00 | 842 | 0.022 |
| github-copilot/claude-haiku-5.5 | 5 | 2.50 | 0.30 | 1.00 | 345 | 0.010 |
| github-copilot/claude-opus-5.5 | 13 | 3.54 | 1.38 | 1.00 | 612 | 0.917 |
| github-copilot/claude-sonnet-5.5 | 4 | 2.43 | 1.14 | 1.00 | 154 | 0.005 |
| github-copilot/gemini-3.8-flash | 3 | 1.54 | 11.06 | 1.00 | 1427 | 0.002 |
| github-copilot/gpt-6-luna | 5 | 2.39 | 0.12 | 1.00 | 290 | 0.022 |
| github-copilot/gpt-6.1-sol | 11 | 3.39 | 0.67 | 1.00 | 449 | 0.477 |
| github-copilot/grok-4.7 | 7 | 2.43 | 6.11 | 1.00 | 1144 | 0.040 |
| github-copilot/mai-code-2-flash | 5 | 1.79 | 1.32 | 1.00 | 273 | 0.022 |
| halogen/halogen-qwen3.8-flash-next | 2 | 1.25 | 7.11 | 1.00 | 944 | 0.001 |

## hard: 5 tasks, B1 github-copilot/claude-opus-5.5, shortlist -

| Model | Passes | Mean grade | Cost per pass | Availability | Median wall s | P(gap <= margin) vs B1 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek/deepseek-flash | 0 | 1.40 | inf | 1.00 | 724 | 0.133 |
| github-copilot/claude-haiku-5.5 | 0 | 1.70 | inf | 1.00 | 659 | 0.133 |
| github-copilot/claude-opus-5.5 | 3 | 3.20 | 4.19 | 1.00 | 1037 | 0.786 |
| github-copilot/claude-sonnet-5.5 | 2 | 2.70 | 1.87 | 1.00 | 395 | 0.476 |
| github-copilot/gemini-3.8-flash | 0 | 1.20 | inf | 1.00 | 1254 | 0.133 |
| github-copilot/gpt-6-luna | 1 | 1.70 | 0.33 | 1.00 | 207 | 0.261 |
| github-copilot/gpt-6.1-sol | 2 | 2.20 | 0.97 | 1.00 | 322 | 0.476 |
| github-copilot/grok-4.7 | 0 | 0.00 | inf | 1.00 | 1577 | 0.133 |
| github-copilot/mai-code-2-flash | 0 | 1.60 | inf | 1.00 | 330 | 0.133 |
| halogen/halogen-qwen3.8-flash-next | 0 | 0.40 | inf | 1.00 | 1173 | 0.133 |

C1 (constant candidate): github-copilot/claude-opus-5.5; best overall: github-copilot/claude-opus-5.5.

Rule features: pathsNamed, briefChars, reposNamed, riskPathNamed. Nested accuracy: 0.288.

H2: inconclusive (Jev -, kind -).
