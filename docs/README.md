# VIGIL Documentation

Documentation index for the VIGIL access recertification engine.

![Recertification engine architecture](architecture.png)

## Start here

| If you want to… | Read |
|---|---|
| Understand what VIGIL is and deploy it quickly | [Project README](../README.md) |
| Understand the engine module at a glance | [Engine overview](../engine/README.md) |
| Build, integrate, operate, or extend the engine | [Developer Guide](../engine/DEVELOPER_GUIDE.md) |
| Integrate a client UI against the REST API | [OpenAPI contract](../engine/openapi.yaml) |
| Operate the system / run incident procedures | [Runbook](../RUNBOOK.md) |

## By audience

- **New to the project** → [Project README](../README.md), then the architecture diagram above.
- **Frontend / integrator** → [OpenAPI contract](../engine/openapi.yaml) and the
  [API reference](../engine/DEVELOPER_GUIDE.md#api-reference) in the Developer Guide.
- **Backend / platform engineer** → [Developer Guide](../engine/DEVELOPER_GUIDE.md), especially
  [Extending the engine: write a connector](../engine/DEVELOPER_GUIDE.md#extending-the-engine-write-a-connector).
- **On-call / operator** → [Runbook](../RUNBOOK.md) and
  [Operations](../engine/DEVELOPER_GUIDE.md#operations).

## Diagram

The architecture diagram is [`architecture.png`](architecture.png) (1600×1000). Update it if
the system changes.
