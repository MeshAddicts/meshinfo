# MeshInfo

Realtime web UI to run against a Meshtastic regional or private mesh network.

## Overview

MeshInfo is written in Python and connects to an MQTT server that is receiving Meshtastic messages for the purpose of visualizing and inspecting traffic. It (currently) uses a filesystem to persist content, such as node info and telemetry. There are plans to optionally support Postgres and SQLite3 as optional persistance storage methods.

To make deployment to run an instance for your mesh easy, Docker support is included. We recommend using Docker Compose using a personalized version of the `docker-compose.yml` file to most easily deploy it, but any seasoned Docker user can also use the Docker image alone.

## Screenshots

TODO: Capture screenshots and make a row of clickable screenshot thumbnails here.

## Supported Meshtastic Message Types

- neighborinfo
- nodeinfo
- position
- telemetry
- text
- traceroute

## Features

### Current

- Chat
- Map
- Nodes
- Node Neighbors
- Mesh Messages
- MQTT Messages
- Telemetry
- Traceroutes

### Upcoming

- Statistics
- Overview of Routes

## Chat

If you're using this and have questions, or perhaps you want to join in on the dev effort and want to interact collaboratively, come chat with us on [#meshinfo on the SacValleyMesh Discord](https://discord.gg/sVHDNAAB).

## Running

### Docker Compose (preferred for 24/7 servers)

#### Setup

```sh
git clone https://github.com/MeshAddicts/meshinfo.git
```

#### To Run

Change to the directory.

```sh
cd meshinfo
```

```sh
docker compose pull && docker compose down && docker compose up -d && docker compose ps && docker compose logs -f meshinfo
```

#### To Update

```sh
git fetch && git pull && docker compose pull && docker compose down && docker compose up -d && docker compose ps && docker compose logs -f meshinfo
```

### Directly (without Docker)

Be sure you have `Python 3.12.4` or higher installed.

```sh
pip install -r requirements.txt
python main.py
```

## Development

### Building a local Docker image

Clone the repository.

```sh
git clone https://github.com/MeshAddicts/meshinfo.git
```

If already existing, be sure to pull updates.

```sh
git fetch && git pull
```

Build. Be sure to specify a related version number and suffix (this example `dev5` but could be your name or initials and a number) as this will help prevent collisions in your local image cache when testing.

```sh
scripts/docker-build.sh 0.0.1dev5
```

### Release

Tag the release using git and push up the tag. The image will be build by GitHub automatically (see: https://github.com/MeshAddicts/meshinfo/actions/workflows/docker.yml).

```sh
git tag v0.0.0 && git push && git push --tags
```

## Contributing

We happily accept Pull Requests!

TODO: Need to rewrite this section.
