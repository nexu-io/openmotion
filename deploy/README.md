# Docker deployment

Run OpenMotion in a container on the machine you work on. The image is built
from this checkout and contains Node.js, Chromium, FFmpeg/ffprobe and CJK fonts,
so the host needs only Docker.

This is a local deployment: the Studio is opened from the same machine at
`http://127.0.0.1:4173`. Access from another machine is not supported yet.

## Start

```bash
cd deploy
cp .env.example .env
docker compose build
docker compose up -d
```

Open `http://127.0.0.1:4173`.

Projects, exports and settings are stored in the `openmotion_data` volume,
mounted at `/data` (`MOTION_DATA_DIR`). `docker compose down` keeps the volume;
`docker compose down -v` deletes it together with every project in it.

## Connect an Agent

The MCP server is a stdio process. Start it inside the running container so it
shares the Studio's data directory and service:

```json
{
  "mcpServers": {
    "openmotion": {
      "command": "docker",
      "args": ["exec", "-i", "openmotion", "node", "--experimental-strip-types", "mcp.ts"]
    }
  }
}
```

Paths passed to MCP tools are container paths. To import local media with
`openmotion_import_assets`, mount the folder into the container and pass the
mounted path.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENMOTION_PORT` | `4173` | Port on the host's `127.0.0.1` and inside the container. Both sides use the same value so returned URLs open on the host. |
| `OPENMOTION_MEM_LIMIT` | `4g` | Container memory limit. Rendering runs Chromium and FFmpeg. |
| `DO_NOT_TRACK` | empty | Set to `1` to disable analytics. |

## How access is restricted

The container sets `MOTION_BIND_HOST=0.0.0.0` so Docker can publish the port,
and Compose publishes it on the host's `127.0.0.1` only. The server still
accepts requests only when the `Host` header is `localhost`, `127.0.0.1` or
`[::1]`, and accepts writes only from its own origin. Publishing the port on
another interface does not make the Studio usable from other machines.

## Known limits

- The web browser tab inside the Studio starts Chromium with its sandbox, which
  is not available to an unprivileged container. Video preview and export are
  not affected.
- Linux is not a pinned native runtime target; the image uses Debian's Chromium
  and FFmpeg instead of the versions in `scripts/runtime-lock.json`.
