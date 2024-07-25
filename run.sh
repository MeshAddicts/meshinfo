#!/usr/bin/env bash

rm -rf /app/spa/*
cp -rf /app/dist/* /app/spa
python main.py
