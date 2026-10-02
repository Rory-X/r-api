// Serialize local read/modify/write mutations, including coverage rebuilds.
// Always release after a failure so later requests can converge again.
let mutationTail: Promise<void> = Promise.resolve();

export async function withRouteMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
