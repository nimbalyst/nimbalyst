/** Label for the local entry in the machine picker: the name other devices see for this machine. */
export function localMachineLabel(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} (this device)` : 'This device';
}
