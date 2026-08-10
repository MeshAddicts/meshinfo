export function convertNodeIdFromHexToInt(inputId: string): number {
  let id = inputId;
  if (id.startsWith("!")) {
    id = id.replace("!", "");
  }
  return parseInt(id, 16);
}

export function convertNodeIdFromIntToHex(id: number): string {
  const idHex = id.toString(16).padStart(8, "0");
  return idHex;
}
