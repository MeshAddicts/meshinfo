# meshinfo frontend

## Usage

- [Install yarn](https://yarnpkg.com/getting-started/install)
- Install dependencies:

```bash
yarn
```

- Start dev server

```bash
yarn dev
```

## Development

If you're having issues with your editor picking up types in TypeScript, follow the [yarn editor sdk docs](https://yarnpkg.com/getting-started/editor-sdks). This repo already includes Visual Studio Code sdks, but they may need to be augmented or regenerated.
If you're using VSCode, make sure you install the recommended extensions. More info can be found in [the yarn docs](https://yarnpkg.com/getting-started/editor-sdks#vscode)

## Notes

The production portion of the frontend runs with an Express server to serve the static files so that you can switch out the api url as needed without rebuilding the container. You can change this by passing `VITE_BASE_API_URL` to the frontend container.
