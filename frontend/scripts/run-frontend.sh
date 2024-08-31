echo "API BASE URL: " $VITE_API_BASE_URL
yarn build --base=/next/ && npx pm2-runtime /frontend/scripts/server.js
