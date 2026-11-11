/** JSON.parse normally accepts duplicate members and keeps the last value.
 * Walk the already parsed JSON syntax to reject ambiguous object keys, including
 * equivalent escaped names. Bound nesting to prevent parser stack exhaustion. */
export function assertUniqueJsonMembers(wire: string) {
  let position = 0;
  const space = () => {
    while (/\s/.test(wire[position] ?? "") && position < wire.length)
      position++;
  };
  const string = () => {
    const start = position++;
    while (position < wire.length) {
      const c = wire[position++]!;
      if (c === "\\") position++;
      else if (c === '"')
        return JSON.parse(wire.slice(start, position)) as string;
    }
    throw Error("INVALID_JSON");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw Error("JSON_DEPTH");
    space();
    if (wire[position] === '"') {
      string();
      return;
    }
    if (wire[position] === "{") {
      position++;
      const keys = new Set<string>();
      space();
      while (wire[position] !== "}") {
        if (wire[position] !== '"') throw Error("INVALID_JSON");
        const key = string();
        if (keys.has(key)) throw Error("DUPLICATE_JSON_MEMBER");
        keys.add(key);
        space();
        if (wire[position++] !== ":") throw Error("INVALID_JSON");
        value(depth + 1);
        space();
        if (wire[position] !== ",") break;
        position++;
        space();
      }
      if (wire[position++] !== "}") throw Error("INVALID_JSON");
      return;
    }
    if (wire[position] === "[") {
      position++;
      space();
      while (wire[position] !== "]") {
        value(depth + 1);
        space();
        if (wire[position] !== ",") break;
        position++;
      }
      if (wire[position++] !== "]") throw Error("INVALID_JSON");
      return;
    }
    const start = position;
    while (position < wire.length && !/[\s,\]}]/.test(wire[position]!))
      position++;
    if (start === position) throw Error("INVALID_JSON");
  };
  value(0);
  space();
  if (position !== wire.length) throw Error("INVALID_JSON");
}
