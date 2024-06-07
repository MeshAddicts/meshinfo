#!/usr/bin/env bash

# set version from args

# build and push

# set version from args if not, exit
if [ -z "$1" ]
  then
    echo "No version supplied"
    exit 1
fi

REPO=MeshAddicts/meshinfo
VERSION=$1

docker build -t ghcr.io/$REPO:$VERSION --platform=linux/amd64 . && docker push ghcr.io/$REPO:$VERSION
