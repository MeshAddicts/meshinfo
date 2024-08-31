import express from "express";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 80;

// Serve static files from the dist directory
app.use("/next", express.static(path.join(__dirname, "../dist")));

// log all requests
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

// Handle every other route with index.html, which will contain a script tag to your application's JavaScript
app.get("/next/*", (req, res) => {
  res.sendFile(path.join(__dirname, "../dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
