#!/bin/sh
echo "NODE_ENV: " $NODE_ENV
echo "API BASE URL: " $VITE_API_BASE_URL
yarn run dev --host 0.0.0.0
