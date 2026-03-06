echo "NODE_ENV: " $NODE_ENV
echo "API BASE URL: " $VITE_API_BASE_URL

if [ "$NODE_ENV" == "dev" ]; then
  yarn run dev --host 0.0.0.0
else
  yarn build --base=/ && node /frontend/scripts/server.js
fi
