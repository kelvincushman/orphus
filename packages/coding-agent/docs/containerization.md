# Containerization

Orphus runs with all permissions by default, but in some cases, you will want to have more control over what directories Orphus can write to and which accesses it has.

There are two general options. You can either
1. run the whole `orphus` process inside an isolated environment, or
2. run `orphus` on the host and route tool execution into an isolated environment.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](https://github.com/kelvincushman/orphus/tree/main/packages/coding-agent/examples/extensions/gondolin). |
| Plain Docker | Whole `orphus` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `orphus` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway. |

Extensions run wherever the `orphus` process runs. If you run host `orphus` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
Use the [example extension](https://github.com/kelvincushman/orphus/tree/main/packages/coding-agent/examples/extensions/gondolin) when you want `orphus` on the host but all built-in tools routed into the VM.

Setup:

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.orphus/agent/extensions/gondolin
cd ~/.orphus/agent/extensions/gondolin
bun install --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
orphus -e ~/.orphus/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `find`, and `search` so the default coding tools operate inside the VM.
User `!` commands are routed into the VM, as well.
File changes under `/workspace` write through to the host.

Requirements: Bun for dependency installation, Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

## Plain Docker

Run the whole `orphus` process in Docker when you want the simplest local container boundary.

`Dockerfile.orphus`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @orphus/coding-agent

WORKDIR /workspace
ENTRYPOINT ["orphus"]
```

Build and run:

```bash
docker build -t orphus-sandbox -f Dockerfile.orphus .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v orphus-agent-home:/root/.orphus/agent \
  orphus-sandbox
```

The `-v "$PWD:/workspace"` mounts your current directory into the container at /workspace such that reads and writes in `/workspace` inside Docker directly affect your host files, like in the Gondolin example.

Use a named volume for `/root/.orphus/agent` if you want container-local settings and sessions. Mounting your host `~/.orphus/agent` exposes host auth and session files to the container.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls.
OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway.
Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `orphus` inside an OpenShell sandbox:

```bash
openshell sandbox create --name orphus-sandbox --from orphus -- orphus
```

In this pattern, the whole `orphus` process runs inside the sandbox.
Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine.
Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload orphus-sandbox ./repo /workspace
openshell sandbox download orphus-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox.
When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream.
Configure Orphus to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.
