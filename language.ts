// - lex
// - parse
// - compile to bytecode
// - run bytecode

function impossible(x: never): never {
  return x;
}

type Location = {
  line: number;
  column: number;
};
type Span = {
  start: Location;
  end: Location;
};
type Token = {
  type: 'name' | 'string' | 'number' | 'other';
  contents: string;
  span: Span;
};

function tokenize(source: string): Token[] {
  // We need a mapping from index to location.
  const locations: Location[] = [];
  {
    let line = 1;
    let column = 1;
    for (let i = 0; i < source.length; i++) {
      locations.push({ line, column });
      if (source[i] === '\n') {
        line++;
        column = 1;
        continue;
      }
      column++;
    }
    locations.push({ line, column });
  }
  // Repeatedly find the next token.
  const tokenTypes: { pattern: RegExp; type?: 'name' | 'number' | 'ignore' | 'string' }[] = [
    { pattern: /func|var/ },
    { pattern: /\d+/, type: 'number' },
    { pattern: /"[^"\\]*"/, type: 'string' },
    { pattern: /[a-zA-Z]+/, type: 'name' },
    { pattern: /[\(\)\[\]\{\}.|@#,:&;]/ },
    { pattern: /[*\/?^<>=+-]+/ },
    { pattern: /\s+/, type: 'ignore' },
  ];

  const tokens: Token[] = [];

  let from = 0;
  while (from < source.length) {
    let bestMatch: { len: number; index: number } | null = null;
    for (let i = 0; i < tokenTypes.length; i++) {
      const match = source.slice(from).match(tokenTypes[i].pattern);
      if (!match) {
        continue;
      }
      if (source.slice(from, from + match[0].length) !== match[0]) {
        continue;
      }
      if (bestMatch && match[0].length <= bestMatch.len) {
        continue;
      }
      bestMatch = { index: i, len: match[0].length };
    }
    if (!bestMatch) {
      throw new Error(`at location ${JSON.stringify(locations[from])}, unknown token`);
    }

    const tokenType = tokenTypes[bestMatch.index];
    if (tokenType.type === 'ignore') {
      from += bestMatch.len;
      continue;
    }
    const token: Token = {
      contents: source.slice(from, from + bestMatch.len),
      span: { start: locations[from], end: locations[from + bestMatch.len - 1] },
      type: tokenType.type || 'other',
    };
    tokens.push(token);
    from += bestMatch.len;
  }
  return tokens;
}

type Block = {
  statements: Statement[];
};
type Statement =
  | {
      is: 'expression';
      expression: Expression;
    }
  | { is: 'return'; expression: Expression }
  | { is: 'var'; name: Token; expression: Expression }
  | { is: 'assignment'; source: Expression; target: Expression };
type Expression =
  | {
      is: 'call';
      func: Expression;
      args: Expression[];
    }
  | { is: 'string'; string: Token }
  | { is: 'number'; number: Token }
  | { is: 'name'; name: Token }
  | { is: 'func'; args: Token[]; body: Block };

class TokenReader {
  constructor(public readonly tokens: Token[], public index: number) {}
  public peek(): Token | null {
    return this.tokens[this.index] || null;
  }
  public advance(): void {
    this.index++;
  }
  public location(): Location {
    return this.index >= this.tokens.length ? this.tokens[this.tokens.length - 1].span.end : this.tokens[this.index].span.start;
  }
  public expect(predicate: (t: Token) => boolean, message: string): Token {
    if (this.index >= this.tokens.length || !predicate(this.tokens[this.index])) {
      return impossible(this.fail(message));
    }
    this.advance();
    return this.tokens[this.index - 1];
  }
  public fail(message: string): never {
    throw new Error(`${message} at ${JSON.stringify(this.location())}`);
  }
}

function parseBlockContents(r: TokenReader): Block {
  const statements: Statement[] = [];
  while (r.peek() && r.peek()!.contents !== '}') {
    statements.push(parseStatement(r));
  }
  return { statements };
}

function parseBlockBracketed(r: TokenReader): Block {
  r.expect(token => token.contents === '{', 'an open bracket to open a block');
  const body = parseBlockContents(r);
  r.expect(token => token.contents === '}', 'a closing bracket to close a block');
  return body;
}

function parseStatement(r: TokenReader): Statement {
  const front = r.peek();
  if (front && front.contents === 'var') {
    r.advance();
    const name = r.expect(token => token.type === 'name', 'variable name');
    r.expect(token => token.contents === '=', "'=' following variable name");
    const expression = parseExpression(r);
    r.expect(token => token.contents === ';', "expected ';' after var initialization");
    return { is: 'var', name, expression };
  }
  const expression = parseExpression(r);
  if (r.peek() && r.peek()!.contents === '=') {
    r.advance();
    const target = expression;
    const source = parseExpression(r);
    r.expect(token => token.contents === ';', "expected ';' after assignment");
    return { is: 'assignment', source, target };
  }
  r.expect(token => token.contents === ';', "expected ';' after statement");
  return { is: 'expression', expression };
}

function parseExpression(r: TokenReader): Expression {
  const token = r.peek();
  if (!token) {
    return r.fail('expected expression');
  }
  if (token.contents === 'func') {
    r.advance();
    r.expect(t => t.contents === '(', "open parenthesis following 'func' keyword");
    const args: Token[] = [];
    while (r.peek() && r.peek()!.contents !== ')') {
      const name = r.expect(token => token.type === 'name', 'argument name');
      args.push(name);
      const next = r.peek();
      if (!next) {
        return r.fail('unexpected end of input inside argument list');
      }
      if (next.contents === ',') {
        r.advance();
        continue;
      }
      if (next.contents === ')') {
        break;
      }
      return r.fail('expected argument');
    }
    r.expect(t => t.contents === ')', "close parenthesis following 'func' keyword");
    const body = parseBlockBracketed(r);
    return { is: 'func', args, body };
  }
  if (token.type === 'string') {
    r.advance();
    return parseExpressionTrail({ is: 'string', string: token }, r);
  }
  if (token.type === 'number') {
    r.advance();
    return parseExpressionTrail({ is: 'number', number: token }, r);
  }
  if (token.type === 'name') {
    r.advance();
    return parseExpressionTrail({ is: 'name', name: token }, r);
  }
  return r.fail('expected expression');
}

function parseExpressionTrail(root: Expression, r: TokenReader): Expression {
  const token = r.peek();
  if (!token) {
    return root;
  }
  if (token.contents === '(') {
    // It's a call.
    let args: Expression[] = [];
    r.advance(); // skip the open paren
    while (r.peek() && r.peek()!.contents !== ')') {
      const arg = parseExpression(r);
      args.push(arg);
      if (!r.peek() || ![',', ')'].includes(r.peek()!.contents)) {
        return r.fail(`expected ')' or ',' for function call '(' opened at ${JSON.stringify(token.span.start)}`);
      }
      if (r.peek()!.contents === ',') {
        // Skip the comma
        r.advance();
      }
    }
    if (!r.peek() || r.peek()!.contents !== ')') {
      return r.fail(`expected ')' to close function call '(' opened at ${JSON.stringify(token.span.start)}`);
    }
    r.advance();
    return parseExpressionTrail({ is: 'call', func: root, args }, r);
  }
  return root;
}

// Without worrying about typing information, we can build a (very bad) stack-based VM.
// The VM only needs to be complicated enough to compute basic expressions, BUT we also
// need to support delimited (one-shot) continuations.

// Data model:
// Each function has a stack frame. The stack frame includes the following:
// - program counter [stored internally to simplify continuation support]
// - return-to frame pointer + return value pointer
// - raise-to frame pointer + raise value pointer (assign to raised value & current frame pointer, then resume).
// - variable array (variables are referred to by index)
// - expression stack (an anonymous stack used for basic operations; simplifies things).
// - argument array (referred to by index)
// - code (a sequence of operations including branching instructions that move to fixed indices)

// In the future, additional optimization can be done to cut down the overhead of many of these things.
// Having multiple continuation pointers is also likely to be helpful (maybe they should just be values?)

// Operations:
// - pushString["s"]: push string literal
// - pushArgument[1]: push argument with fixed index
// - pushVariable[1]: push variable with fixed index
// - pushGlobal[n]: push global in slot n (e.g. a function)
// - call[n]: pop n values and then the function pointer; create a new stack frame and run it.
// - return[]: pop a value, write it onto the stack frame of caller, and return
// - raise[]: pop a value, write it onto the raise-to frame, and jump back there. The resumed value will be pushed.
// - setVariable[n]: pop a value and store it in the given variable by index

// Will later need operations for creating closures, or else accepting that all functions will
// just be functoids with virtual call() methods.

// Will also need branches.

// Everything else will be achieved by function calls to built-ins, somehow.

type Operation =
  | { operation: 'push-nil' }
  | { operation: 'push-string'; value: string }
  | { operation: 'push-number'; value: number }
  | { operation: 'push-argument'; index: number }
  | { operation: 'push-variable'; index: number }
  | { operation: 'push-builtin'; name: string }
  | { operation: 'push-function'; name: string; bound: number }
  | { operation: 'discard' }
  | { operation: 'call'; arity: number }
  | { operation: 'return' }
  | { operation: 'raise' }
  | { operation: 'set-variable'; index: number };

type Value =
  | { value: 'unit' }
  | { value: 'string'; string: string }
  | { value: 'number'; number: number }
  | { value: 'builtin-function'; func: (args: Value[]) => Value }
  | { value: 'user-function'; code: Operation[]; bound: Value[] };

type Frame = {
  readonly arguments: readonly Value[];
  readonly variables: Value[];

  readonly code: readonly Operation[];
  counter: number;

  stack: Value[];
  returnTo: Frame | null;
};

type Emitter = {
  /** `addFunc` returns the id of the created global function */
  addFunc: (code: Operation[]) => string;
};

type Context = {
  variableMapping: Record<string, { is: 'var' | 'arg'; index: number } | { is: 'builtin' }>;
};

function compileBlock(block: Block, context: Context, emitter: Emitter): { code: Operation[] } {
  const code: Operation[] = [];
  for (const statement of block.statements) {
    code.push(...compileStatement(statement, context, emitter).code);
  }
  return { code };
}

function compileStatement(statement: Statement, context: Context, emitter: Emitter): { code: Operation[] } {
  switch (statement.is) {
    case 'expression': {
      const result = compileExpression(statement.expression, context, emitter);
      return { ...result, code: result.code.concat({ operation: 'discard' }) };
    }
    case 'return': {
      const result = compileExpression(statement.expression, context, emitter);
      return { ...result, code: result.code.concat({ operation: 'return' }) };
    }
    case 'var': {
      const freeIndex = Object.keys(context.variableMapping).filter(v => context.variableMapping[v].is === 'var').length;
      context.variableMapping[statement.name.contents] = { is: 'var', index: freeIndex };
      return { code: compileExpression(statement.expression, context, emitter).code.concat([{ operation: 'set-variable', index: freeIndex }]) };
    }
    case 'assignment': {
      if (statement.target.is !== 'name') {
        throw new Error('cannot assign to non-named entity');
      }
      const target = context.variableMapping[statement.target.name.contents];
      if (target.is === 'arg') {
        throw new Error('cannot assign argument');
      } else if (target.is === 'builtin') {
        throw new Error('cannot assign builtin');
      }
      return { code: compileExpression(statement.source, context, emitter).code.concat([{ operation: 'set-variable', index: target.index }]) };
    }
  }
}

function compileExpression(expression: Expression, context: Context, emitter: Emitter): { code: Operation[] } {
  switch (expression.is) {
    case 'string':
      return { code: [{ operation: 'push-string', value: JSON.parse(expression.string.contents) }] };
    case 'number':
      return { code: [{ operation: 'push-number', value: JSON.parse(expression.number.contents) }] };
    case 'call':
      return {
        code: compileExpression(expression.func, context, emitter).code.concat(...expression.args.map(arg => compileExpression(arg, context, emitter).code), [
          { operation: 'call', arity: expression.args.length },
        ]),
      };
    case 'name':
      const item = context.variableMapping[expression.name.contents];
      if (!item) {
        throw new Error(JSON.stringify(expression.name) + ' is not defined');
      }
      if (item.is === 'var') {
        return {
          code: [{ operation: 'push-variable', index: item.index }],
        };
      } else if (item.is === 'arg') {
        return {
          code: [{ operation: 'push-argument', index: item.index }],
        };
      } else {
        return { code: [{ operation: 'push-builtin', name: expression.name.contents }] };
      }
    case 'func': {
      // TODO: only pass the values that are actually referred to.
      const existing = Object.keys(context.variableMapping);
      const subcontext: Context = { variableMapping: {} };
      existing.forEach((name, index) => {
        subcontext.variableMapping[name] = { is: 'arg', index };
      });
      expression.args.forEach((arg, index) => {
        subcontext.variableMapping[arg.contents] = { is: 'arg', index: existing.length + index };
      });
      const body = compileBlock(expression.body, subcontext, emitter);
      const funcName = emitter.addFunc(body.code.concat([{ operation: 'push-nil' }, { operation: 'return' }]));
      const setup: Operation[] = existing.map<Operation>(
        (name: string): Operation => {
          const storage = context.variableMapping[name];
          if (storage.is === 'var') {
            return { operation: 'push-variable', index: storage.index };
          }
          if (storage.is === 'arg') {
            return { operation: 'push-argument', index: storage.index };
          }
          return { operation: 'push-builtin', name };
        },
      );
      return { code: setup.reverse().concat([{ operation: 'push-function', name: funcName, bound: existing.length }]) };
    }
  }
}

function compileRoot(block: Block, rootContext: Context): { code: Operation[]; globals: Record<string, Operation[]> } {
  let globalIndex = 0;
  const globals: Record<string, Operation[]> = {};
  const emitter: Emitter = {
    addFunc: body => {
      const name = `$func${globalIndex}`;
      globals[name] = body;
      globalIndex += 1;
      return name;
    },
  };
  const { code } = compileBlock(block, rootContext, emitter);
  return { code, globals };
}

function runProgram(builtins: Record<string, Value>, userFunctions: Record<string, Operation[]>, code: Operation[]) {
  let currentFrame: Frame = {
    arguments: [],
    variables: [],
    code,
    counter: 0,
    stack: [],
    returnTo: null,
  };
  while (currentFrame.counter < currentFrame.code.length) {
    const operation = currentFrame.code[currentFrame.counter];
    switch (operation.operation) {
      case 'push-nil': {
        currentFrame.stack.push({ value: 'unit' });
        currentFrame.counter++;
        break;
      }
      case 'push-string': {
        currentFrame.stack.push({ value: 'string', string: operation.value });
        currentFrame.counter++;
        break;
      }
      case 'push-number': {
        currentFrame.stack.push({ value: 'number', number: operation.value });
        currentFrame.counter++;
        break;
      }
      case 'push-argument': {
        if (operation.index >= currentFrame.arguments.length) {
          throw new Error(`cannot push argument[${operation.index}] since only ${currentFrame.arguments.length} arguments have been passed.`);
        }
        currentFrame.stack.push(currentFrame.arguments[operation.index]);
        currentFrame.counter++;
        break;
      }
      case 'push-variable': {
        currentFrame.stack.push(currentFrame.variables[operation.index] || { value: 'unit' });
        currentFrame.counter++;
        break;
      }
      case 'push-builtin': {
        currentFrame.stack.push(builtins[operation.name]);
        currentFrame.counter++;
        break;
      }
      case 'push-function': {
        const bound: Value[] = [];
        for (let i = 0; i < operation.bound; i++) {
          const boundValue = currentFrame.stack.pop();
          if (!boundValue) {
            throw new Error(`cannot extract bound value ${i} of ${operation.bound} since the stack is empty`);
          }
          bound.push(boundValue);
        }
        currentFrame.stack.push({ value: 'user-function', code: userFunctions[operation.name], bound });
        currentFrame.counter++;
        break;
      }
      case 'discard': {
        currentFrame.stack.pop();
        currentFrame.counter++;
        break;
      }
      case 'call': {
        const args: Value[] = [];
        for (let i = 0; i < operation.arity; i++) {
          const arg = currentFrame.stack.pop();
          if (!arg) {
            throw new Error(`expecting value to pop argument ${i + 1} of ${operation.arity} for call`);
          }
          args.push(arg);
        }
        const func = currentFrame.stack.pop();
        if (!func) {
          throw new Error(`expecting function value with arity ${operation.arity}`);
        }
        currentFrame.counter++; // For when it's resumed
        if (func.value === 'string') {
          throw new Error('cannot call string');
        }
        if (func.value === 'unit') {
          throw new Error(`cannot call unit`);
        }
        if (func.value === 'builtin-function') {
          currentFrame.stack.push(func.func(args));
          break;
        }
        if (func.value === 'user-function') {
          currentFrame = {
            arguments: func.bound.concat(args),
            variables: [],
            code: func.code,
            counter: 0,
            stack: [],
            returnTo: currentFrame,
          };
          break;
        }
      }
      case 'return': {
        const value = currentFrame.stack.pop()!;
        if (!currentFrame.returnTo) {
          throw new Error('cannot return from global function');
        }
        currentFrame = currentFrame.returnTo;
        currentFrame.stack.push(value);
        break;
      }
      case 'set-variable': {
        const value = currentFrame.stack.pop()!;
        currentFrame.variables[operation.index] = value;
        currentFrame.counter++;
        break;
      }
      default:
        throw new Error(operation.operation + ' is not yet implemented');
    }
  }
}

const example = `
var hello = "Hello,";
hello = "Hi,";
var thrice = func(f) {
  var count = 1;
  f(count);
  count = add(count, count);
  f(count);
  count = add(count, count);
  f(count);
};

print(hello);
print(" world");
thrice(func(c) {
  print("!");
  print(c);
});
`;

const exampleTokens = tokenize(example);

const exampleParsed = parseBlockContents(new TokenReader(exampleTokens, 0));

const exampleCode = compileRoot(exampleParsed, { variableMapping: { print: { is: 'builtin' }, add: { is: 'builtin' } } });

runProgram(
  {
    print: {
      value: 'builtin-function',
      func: args => {
        console.info('print', args);
        return { value: 'unit' };
      },
    },
    add: {
      value: 'builtin-function',
      func: args => {
        if (args.length !== 2) {
          throw new Error(`cannot add more/less than 2 values: ${JSON.stringify(args)}`);
        }
        const [arg1, arg2] = args;
        if (arg1.value !== 'number') {
          throw new Error(`cannot add non-number: ${JSON.stringify(args)}`);
        }
        if (arg2.value !== 'number') {
          throw new Error(`cannot add non-number: ${JSON.stringify(args)}`);
        }
        return { value: 'number', number: arg1.number + arg2.number };
      },
    },
  },
  exampleCode.globals,
  exampleCode.code,
);
