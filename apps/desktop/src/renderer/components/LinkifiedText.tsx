import { Fragment, type ReactNode } from "react";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、)\]}]+$/u;

export function LinkifiedText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index;
    const candidate = match[0];
    if (index > cursor) {
      nodes.push(text.slice(cursor, index));
    }
    const url = candidate.replace(TRAILING_PUNCTUATION, "");
    const suffix = candidate.slice(url.length);
    nodes.push(
      <Fragment key={`${index}-${url}`}>
        <a href={url} target="_blank" rel="noreferrer noopener">
          {url}
        </a>
        {suffix}
      </Fragment>,
    );
    cursor = index + candidate.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return <>{nodes}</>;
}
