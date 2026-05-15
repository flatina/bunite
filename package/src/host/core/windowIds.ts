let nextWindowId = 1;

export function getNextWindowId() {
  const id = nextWindowId;
  nextWindowId += 1;
  return id;
}
