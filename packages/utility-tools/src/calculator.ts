import { Type } from "typebox";
import { ToolExecutionError, type ToolDefinition } from "@deepfield/tool-platform";

const MAX_EXPRESSION_LENGTH = 256;

const calculatorInputSchema = Type.Object(
  { expression: Type.String({ minLength: 1, maxLength: MAX_EXPRESSION_LENGTH }) },
  { additionalProperties: false },
);
const calculatorOutputSchema = Type.Object(
  { value: Type.Number() },
  { additionalProperties: false },
);

class ArithmeticParser {
  readonly #expression: string;
  #position = 0;

  constructor(expression: string) {
    this.#expression = expression;
  }

  parse(): number {
    const value = this.#parseExpression();
    this.#skipWhitespace();
    if (this.#position !== this.#expression.length) {
      throw new ToolExecutionError("invalid_input");
    }
    return this.#finite(value);
  }

  #parseExpression(): number {
    let value = this.#parseTerm();
    while (true) {
      if (this.#consume("+")) {
        value = this.#finite(value + this.#parseTerm());
      } else if (this.#consume("-")) {
        value = this.#finite(value - this.#parseTerm());
      } else {
        return value;
      }
    }
  }

  #parseTerm(): number {
    let value = this.#parseUnary();
    while (true) {
      if (this.#consume("*")) {
        value = this.#finite(value * this.#parseUnary());
      } else if (this.#consume("/")) {
        const divisor = this.#parseUnary();
        if (divisor === 0) throw new ToolExecutionError("invalid_input");
        value = this.#finite(value / divisor);
      } else if (this.#consume("%")) {
        const divisor = this.#parseUnary();
        if (divisor === 0) throw new ToolExecutionError("invalid_input");
        value = this.#finite(value % divisor);
      } else {
        return value;
      }
    }
  }

  #parseUnary(): number {
    if (this.#consume("+")) return this.#parseUnary();
    if (this.#consume("-")) return this.#finite(-this.#parseUnary());
    return this.#parsePower();
  }

  #parsePower(): number {
    const base = this.#parsePrimary();
    if (!this.#consume("^")) return base;
    return this.#finite(base ** this.#parseUnary());
  }

  #parsePrimary(): number {
    if (this.#consume("(")) {
      const value = this.#parseExpression();
      if (!this.#consume(")")) throw new ToolExecutionError("invalid_input");
      return value;
    }
    this.#skipWhitespace();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(
      this.#expression.slice(this.#position),
    );
    if (match === null) throw new ToolExecutionError("invalid_input");
    this.#position += match[0].length;
    return this.#finite(Number(match[0]));
  }

  #consume(token: string): boolean {
    this.#skipWhitespace();
    if (!this.#expression.startsWith(token, this.#position)) return false;
    this.#position += token.length;
    return true;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.#expression[this.#position] ?? "")) {
      this.#position += 1;
    }
  }

  #finite(value: number): number {
    if (!Number.isFinite(value)) throw new ToolExecutionError("invalid_input");
    return value;
  }
}

export function createCalculatorDefinition(): ToolDefinition<
  typeof calculatorInputSchema,
  typeof calculatorOutputSchema
> {
  return {
    identity: { name: "calculator", version: 1 },
    label: "Calculator",
    userFacing: { name: "计算器", description: "计算基本算术表达式" },
    description: "Evaluate a finite arithmetic expression using numbers and basic operators.",
    inputSchema: calculatorInputSchema,
    outputSchema: calculatorOutputSchema,
    effect: "local.compute",
    timeoutMs: 1000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 8,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: { formatOutput: (output) => String(output.value) },
    execute: async ({ expression }) => {
      if (expression.length === 0 || expression.length > MAX_EXPRESSION_LENGTH) {
        throw new ToolExecutionError("invalid_input");
      }
      return { value: new ArithmeticParser(expression).parse() };
    },
  };
}
