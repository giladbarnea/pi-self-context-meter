# pi-self-context-meter

A minimal Pi extension that gives the agent a `context_meter` tool.

The tool reports the current context use against the model's full context window.

## Install

```sh
pi install .
```

## Output

```text
You have used 87k tokens out of 272k available (used 32%).
```

Pi's transcript shows this result as one line: a meter in the context colors of pi-simple-team, the used percent, the token counts and what is left.
