export function mount(root: Element, options: { label: string }): () => void {
  root.textContent = options.label;
  return () => {
    root.textContent = "";
  };
}
