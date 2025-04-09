export class ESP32Emulator {
  constructor(canvasContext) {
    this.flash = new Uint8Array(4 * 1024 * 1024); // 4MB flash
    this.ram = new Uint8Array(520 * 1024);        // 520KB SRAM
    this.pc = 0x40000000;                         // Starting address in flash
    this.registers = new Uint8Array(16);          // Simplified register file
    this.compareFlag = 0;                         // For CMP

    this.gpioState = new Array(40).fill(0);       // 40 GPIO pins
    this.gpioMode = new Array(40).fill('input');  // Default all pins to input
    this.serialBuffer = '';                       // Simulated UART output
    this.delayCounter = 0;                        // For DLY opcode
    this.adcInput = () => 2048;                   // Default ADC value
    this.spiBuffer = '';                          // Simulated SPI output
    this.screenContext = canvasContext;           // Canvas for screen
    this.screenX = 0;                             // Text position
    this.screenY = 20;


    this.opcodes = {
      0x01: this.loadImmediate.bind(this), // LDI reg, value
      0x02: this.storeGPIO.bind(this),     // STG reg, pin
      0x03: this.loadGPIO.bind(this),      // LDG reg, pin
      0x04: this.jump.bind(this),          // JMP address
      0x05: this.serialWrite.bind(this),   // SER reg
      0x11: this.add.bind(this),           // ADD reg1, reg2
      0x12: this.sub.bind(this),           // SUB reg1, reg2
      0x13: this.compare.bind(this),       // CMP reg1, reg2
      0x14: this.jumpIfEqual.bind(this),   // JEQ address
      0x15: this.jumpIfNotEqual.bind(this),// JNE address
      0x16: this.delay.bind(this),         // DLY cycles
      0x17: this.readADC.bind(this),       // ADC reg
      0x18: this.spiWrite.bind(this),      // SPI reg
      0x19: this.screenPrint.bind(this),   // SCR reg
      0x1A: this.clearScreen.bind(this),   // CLS
      0x1B: this.drawPixel.bind(this),     // PIX regX, regY
      0x1C: this.moveX.bind(this),         // MOVX reg
      0x1D: this.moveY.bind(this),         // MOVY reg
      0x1E: this.jumpIfGreater.bind(this),  // JG address
      0x1F: this.jumpIfLess.bind(this),     // JL address
    };

    this.running = false;

    this.grammar = `
      Program
        = _ statements:(Statement _)* { return statements.map(s => s[0]); }

      Statement
        = VarDecl
        / Assignment
        / IfStatement
        / WhileStatement
        / ScreenPixel
        / ScreenPrint
        / ScreenClear
        / ScreenMove
        / Delay

      VarDecl
        = "int" _ name:Identifier _ "=" _ value:Integer _ ";" { return { type: "VarDecl", name, value }; }

      Assignment
        = name:Identifier _ op:("+=" / "-=" / "=") _ value:Expression _ ";" { return { type: "Assignment", name, op, value }; }

      IfStatement
        = "if" _ "(" _ left:Identifier _ op:(">" / "<") _ right:Integer _ ")" _ "{" _ body:(Statement _)* _ "}" { return { type: "If", left, op, right, body: body.map(s => s[0]) }; }

      WhileStatement
        = "while" _ "(" _ "1" _ ")" _ "{" _ body:(Statement _)* _ "}" { return { type: "While", body: body.map(s => s[0]) }; }

      ScreenPixel
        = "screen_pixel" _ "(" _ x:Expression _ "," _ y:Expression _ ")" _ ";" { return { type: "ScreenPixel", x, y }; }

      ScreenPrint
        = "screen_print" _ "(" _ value:String _ ")" _ ";" { return { type: "ScreenPrint", value }; }

      ScreenClear
        = "screen_clear" _ "(" _ ")" _ ";" { return { type: "ScreenClear" }; }

      ScreenMove
        = "screen_move" _ "(" _ x:Expression _ "," _ y:Integer _ ")" _ ";" { return { type: "ScreenMove", x, y }; }

      Delay
        = "delay_cycles" _ "(" _ cycles:Integer _ ")" _ ";" { return { type: "Delay", cycles }; }

      Expression
        = op:("-") _ expr:Expression { return { type: "UnaryExpr", op, expr }; }
        / left:Identifier _ op:("+" / "-") _ right:Integer { return { type: "BinaryExpr", left, op, right }; }
        / Identifier
        / Integer

      Identifier
        = first:[a-zA-Z_] rest:[a-zA-Z0-9_]* { return first + rest.join(""); }

      Integer
        = digits:[0-9]+ { return parseInt(digits.join(""), 10); }

      String
        = "\\"" value:[^\\"]* "\\"" { return value.join(""); }

      _ "whitespace"
        = [ \\t\\n\\r]*
    `;

    try {
      console.log('Generating parser from grammar using Peggy...'); // Keep this log
      this.parser = peggy.generate(this.grammar);
      console.log('Parser generated successfully.'); // Keep this log
    } catch (e) {
      console.error('Failed to generate parser:', e.message); // Keep this log
      this.parser = null;
    }
  }

  // Simplified log method: only log to console for essential messages
  log(message) {
    console.log(message);
  }

  setADCInput(callback) {
    this.adcInput = callback;
  }

  loadFirmware(data) {
    if (data.length > this.flash.length) {
      console.error('Error: Firmware exceeds flash size'); // Keep this log
      return;
    }
    this.flash.set(data, 0x00000);
    this.pc = 0x40000000;
    this.registers.fill(0);
    this.compareFlag = 0;
    this.serialBuffer = '';
    this.spiBuffer = '';
    this.screenContext.clearRect(0, 0, 320, 240);
    this.screenX = 0;
    this.screenY = 20;
    console.log('Firmware loaded:', Array.from(data).join(', ')); // Keep this log
  }

  step() {
    if (!this.running || this.pc - 0x40000000 >= this.flash.length) {
      this.running = false;
      return;
    }

    if (this.delayCounter > 0) {
      this.delayCounter--;
      return;
    }

    const offset = this.pc - 0x40000000;
    const opcode = this.flash[offset];
    const instr = this.opcodes[opcode];
    if (!instr) {
      console.error(`Error: Unknown opcode: 0x${opcode.toString(16)} at PC: ${this.pc.toString(16)}`); // Keep this log
      this.running = false;
      return;
    }

    const length = this.flash[offset + 1];
    const operands = this.flash.slice(offset + 2, offset + 2 + length);

    const jumped = instr(...operands);
    const nextPC = jumped ? this.pc : this.pc + 1 + 1 + length;
    
    if (!jumped) {
      this.pc += 1 + 1 + length;
    }
  }

  loadImmediate(reg, value) {
    this.registers[reg] = value;
    return false;
  }

  storeGPIO(reg, pin) {
    if (pin < 40) {
      this.gpioState[pin] = this.registers[reg] & 1;
    }
    return false;
  }

  loadGPIO(reg, pin) {
    if (pin < 40) {
      this.registers[reg] = this.gpioState[pin];
    }
    return false;
  }

  jump(address) {
    this.pc = 0x40000000 + address;
    return true;
  }

  serialWrite(reg) {
    const char = String.fromCharCode(this.registers[reg]);
    this.serialBuffer += char;
    return false;
  }

  add(reg1, reg2) {
    this.registers[reg1] = (this.registers[reg1] + this.registers[reg2]) & 0xFF;
    return false;
  }

  sub(reg1, reg2) {
    this.registers[reg1] = (this.registers[reg1] - this.registers[reg2]) & 0xFF;
    return false;
  }

  compare(reg1, reg2) {
    const val1 = this.registers[reg1];
    const val2 = this.registers[reg2];
    this.compareFlag = val1 === val2 ? 0 : val1 > val2 ? 1 : -1;
    return false;
  }

  jumpIfEqual(address) {
    if (this.compareFlag === 0) {
      this.pc = 0x40000000 + address;
      return true;
    }
    return false;
  }

  jumpIfNotEqual(address) {
    if (this.compareFlag !== 0) {
      this.pc = 0x40000000 + address;
      return true;
    }
    return false;
  }

  jumpIfGreater(address) {
    if (this.compareFlag > 0) {
      this.pc = 0x40000000 + address;
      return true;
    }
    return false;
  }

  jumpIfLess(address) {
    if (this.compareFlag < 0) {
      this.pc = 0x40000000 + address;
      return true;
    }
    return false;
  }

  delay(cyclesLow, cyclesHigh) {
    this.delayCounter = (cyclesHigh << 8) | cyclesLow;
    return false;
  }

  readADC(reg) {
    this.registers[reg] = Math.min(this.adcInput(), 4095);
    return false;
  }

  spiWrite(reg) {
    const char = String.fromCharCode(this.registers[reg]);
    this.spiBuffer += char;
    return false;
  }

  screenPrint(reg) {
    const char = String.fromCharCode(this.registers[reg]);
    this.screenContext.fillStyle = 'white';
    this.screenContext.font = '16px Monospace';
    if (char === '\n') {
      this.screenX = 0;
      this.screenY += 20;
    } else {
      this.screenContext.fillText(char, this.screenX, this.screenY);
      this.screenX += 10;
    }
    if (this.screenX >= 320) {
      this.screenX = 0;
      this.screenY += 20;
    }
    if (this.screenY >= 240) {
      this.screenContext.clearRect(0, 0, 320, 240);
      this.screenY = 20;
    }
    return false;
  }

  clearScreen() {
    this.screenContext.clearRect(0, 0, 320, 240);
    this.screenX = 0;
    this.screenY = 20;
    return false;
  }

  drawPixel(regX, regY) {
    this.screenContext.fillStyle = 'white';
    this.screenContext.fillRect(this.registers[regX], this.registers[regY], 1, 1);
    return false;
  }

  moveX(reg) {
    this.screenX = this.registers[reg];
    return false;
  }

  moveY(reg) {
    this.screenY = this.registers[reg];
    return false;
  }

  run() {
    this.running = true;
    const emulate = () => {
      if (this.running) {
        for (let i = 0; i < 280; i++) {
          this.step();
        }
        requestAnimationFrame(emulate);
      }
    };
    emulate();
  }

  getGPIOStates() {
    return this.gpioState.map((state, i) => `GPIO${i}: ${state}`).join('<br>');
  }

  getSerialOutput() {
    return 'Serial: ' + this.serialBuffer + '<br>SPI: ' + this.spiBuffer;
  }

  compileCode(code) {
    this.registers.fill(0);

    if (!this.parser) {
      return { success: false, error: 'Parser not initialized' };
    }

    let ast;
    try {
      ast = this.parser.parse(code);
      console.log('AST generated:\n', JSON.stringify(ast, null, 2)); // Keep this log
    } catch (e) {
      console.error('Parse error:', e.message); // Keep this log
      return { success: false, error: `Parse error: ${e.message}` };
    }

    const firmware = [];
    let address = 0;
    let loopStart = null;
    const ifBlocks = [];

    let x = 0, y = 0, dx = 0;
    let initializationDone = false;
    let xPlus10Computed = false;
    let yPlus10Computed = false;

    const varMap = { x: 5, y: 6, dx: 7 };

    const generateOpcodes = (node) => {
      if (Array.isArray(node)) {
        node.forEach(generateOpcodes);
        return;
      }

      switch (node.type) {
        case "VarDecl":
          if (varMap[node.name]) {
            const value = node.value & 0xFF;
            firmware.push(0x01, 0x02, varMap[node.name], value);
            address += 4;
            if (node.name === "x") x = value;
            if (node.name === "y") y = value;
            if (node.name === "dx") dx = value;
          }
          break;

        case "ScreenClear":
          firmware.push(0x1A, 0x00);
          address += 2;
          break;

        case "ScreenPixel":
          let xReg = 5, yReg = 6;
          if (node.x.type === "BinaryExpr" && node.x.left === "x") {
            xReg = 1;
            if (!xPlus10Computed) {
              firmware.push(0x01, 0x02, 0x01, 0);
              address += 4;
              firmware.push(0x11, 0x02, 0x01, 0x05);
              address += 4;
              firmware.push(0x01, 0x02, 0x00, node.x.right);
              address += 4;
              firmware.push(node.x.op === "+" ? 0x11 : 0x12, 0x02, xReg, 0x00);
              address += 4;
              xPlus10Computed = true;
            }
          } else if (node.x === "x") {
            xReg = 5;
          }

          if (node.y.type === "BinaryExpr" && node.y.left === "y") {
            yReg = 2;
            if (!yPlus10Computed) {
              firmware.push(0x01, 0x02, 0x02, 0);
              address += 4;
              firmware.push(0x11, 0x02, 0x02, 0x06);
              address += 4;
              firmware.push(0x01, 0x02, 0x00, node.y.right);
              address += 4;
              firmware.push(node.y.op === "+" ? 0x11 : 0x12, 0x02, yReg, 0x00);
              address += 4;
              yPlus10Computed = true;
            }
          } else if (node.y === "y") {
            yReg = 6;
          }

          firmware.push(0x1B, 0x02, xReg, yReg);
          address += 4;
          break;

        case "ScreenMove":
          let xVal = node.x;
          if (xVal.type === "BinaryExpr") {
            return;
          } else if (typeof xVal === "string" && varMap[xVal]) {
            xVal = varMap[xVal];
          } else {
            xVal = node.x & 0xFF;
            firmware.push(0x01, 0x02, 0x04, xVal);
            address += 4;
            xVal = 4;
          }
          firmware.push(0x1C, 0x01, xVal);
          address += 3;
          firmware.push(0x01, 0x02, 0x04, node.y & 0xFF);
          address += 4;
          firmware.push(0x1D, 0x01, 0x04);
          address += 3;
          break;

        case "ScreenPrint":
          for (let char of node.value) {
            firmware.push(0x01, 0x02, 0x00, char.charCodeAt(0));
            address += 4;
            firmware.push(0x19, 0x01, 0x00);
            address += 3;
          }
          break;

        case "Assignment":
          const varReg = varMap[node.name];
          if (node.op === "=") {
            if (node.value.type === "UnaryExpr" && node.value.op === "-" && node.value.expr === "dx") {
              firmware.push(0x01, 0x02, 0x00, 0);
              address += 4;
              firmware.push(0x12, 0x02, 0x00, 0x07);
              address += 4;
              firmware.push(0x01, 0x02, varReg, 0);
              address += 4;
              firmware.push(0x11, 0x02, varReg, 0x00);
              address += 4;
              dx = (-dx) & 0xFF;
            } else if (typeof node.value === "number") {
              const value = node.value & 0xFF;
              firmware.push(0x01, 0x02, varReg, value);
              address += 4;
              if (node.name === "dx") dx = value;
              if (node.name === "x") {
                x = value;
                xPlus10Computed = false;
                firmware.push(0x01, 0x02, 0x01, 0);
                address += 4;
                firmware.push(0x11, 0x02, 0x01, 0x05);
                address += 4;
                firmware.push(0x01, 0x02, 0x00, 10);
                address += 4;
                firmware.push(0x11, 0x02, 0x01, 0x00);
                address += 4;
                xPlus10Computed = true;
              }
            }
          } else if (node.op === "+=" && node.value === "dx") {
            firmware.push(0x11, 0x02, varReg, 0x07);
            x = (x + dx) & 0xFF;
            address += 4;
            xPlus10Computed = false;
            firmware.push(0x01, 0x02, 0x01, 0);
            address += 4;
            firmware.push(0x11, 0x02, 0x01, 0x05);
            address += 4;
            firmware.push(0x01, 0x02, 0x00, 10);
            address += 4;
            firmware.push(0x11, 0x02, 0x01, 0x00);
            address += 4;
            xPlus10Computed = true;
          }
          break;

        case "If":
          const ifReg = varMap[node.left];
          firmware.push(0x01, 0x02, 0x03, node.right & 0xFF);
          address += 4;
          firmware.push(0x13, 0x02, ifReg, 0x03);
          address += 4;

          if (node.op === ">") {
            firmware.push(0x1E, 0x01, 0x00);
          } else if (node.op === "<") {
            firmware.push(0x1F, 0x01, 0x00);
          }
          const conditionStart = address;
          address += 3;

          ifBlocks.push({ start: conditionStart });
          generateOpcodes(node.body);
          const jumpAddr = address;
          firmware[conditionStart + 2] = jumpAddr & 0xFF;
          ifBlocks.pop();
          break;

        case "While":
          if (!initializationDone) {
            const initEndAddress = address;
            firmware.push(0x04, 0x01, (initEndAddress + 3) & 0xFF);
            address += 3;
            initializationDone = true;
          }
          loopStart = address;
          xPlus10Computed = false;
          yPlus10Computed = false;
          generateOpcodes(node.body);
          const jumpAddress = address;
          firmware.push(0x04, 0x01, loopStart & 0xFF);
          address += 3;
          while (ifBlocks.length > 0) {
            const ifBlock = ifBlocks.pop();
            firmware[ifBlock.start + 2] = jumpAddress & 0xFF;
          }
          loopStart = null;
          break;

        case "Delay":
          firmware.push(0x16, 0x02, node.cycles & 0xFF, (node.cycles >> 8) & 0xFF);
          address += 4;
          break;
      }
    };

    generateOpcodes(ast);
    return { success: true, firmware: new Uint8Array(firmware) };
  }
}
