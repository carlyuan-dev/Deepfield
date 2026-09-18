const OPEN = "<｜｜DSML｜｜ calls>";
const CLOSE = "</｜｜DSML｜｜ calls>";

/** Raw provider protocol is not report text. Retain only a possible marker suffix
 * between deltas, never the control payload. Match literal wire markers only;
 * ordinary prose, HTML and backslashes are not normalized or stripped. */
export class CompanyResearchRawFilter {
  private pending = "";
  private inside = false;

  push(delta: string): string {
    let rest = this.pending + delta;
    this.pending = "";
    let visible = "";
    while (rest.length > 0) {
      const marker = this.inside ? CLOSE : OPEN;
      const index = rest.indexOf(marker);
      if (index >= 0) {
        if (!this.inside) visible += rest.slice(0, index);
        rest = rest.slice(index + marker.length);
        this.inside = !this.inside;
        continue;
      }
      let retained = Math.min(rest.length, marker.length - 1);
      while (retained > 0 && !rest.endsWith(marker.slice(0, retained))) retained--;
      if (!this.inside) visible += rest.slice(0, rest.length - retained);
      this.pending = rest.slice(rest.length - retained);
      break;
    }
    return visible;
  }

  finish(): string {
    // An unterminated block or recognizable truncated opener is still private.
    // A merely ambiguous suffix such as '<' remains ordinary report text.
    const visible = this.inside || this.pending.startsWith("<｜｜DSML") ? "" : this.pending;
    this.pending = "";
    return visible;
  }
}
