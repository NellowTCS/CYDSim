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

    this.logWindow = null;

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
    };

    this.running = false;

    // Define the grammar as a string
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

    // Generate the parser at runtime using Peggy
    try {
      this.log('Generating parser from grammar using Peggy...');
      this.parser = peggy.generate(this.grammar);
      this.log('Parser generated successfully.');
    } catch (e) {
      this.log(`Failed to generate parser: ${e.message}`);
      console.error('Failed to generate parser:', e.message);
      this.parser = null;
    }
  }

  log(message) {
    if (!this.logWindow || this.logWindow.closed) {
      this.logWindow = window.open('', 'ESP32 Emulator Logs', 'width=600,height=400');
      if (this.logWindow) {
        this.logWindow.document.write('<html><body><pre id="logOutput"></pre></body></html>');
        this.logWindow.document.close();
      }
    }
    if (this.logWindow && !this.logWindow.closed) {
      const logOutput = this.logWindow.document.getElementById('logOutput');
      if (logOutput) {
        logOutput.textContent += message + '\n';
        logOutput.scrollTop = logOutput.scrollHeight;
      } else {
        console.log(message);
      }
    } else {
      console.log(message);
    }
  }

  setADCInput(callback) {
    this.adcInput = callback;
  }

  loadFirmware(data) {
    if (data.length > this.flash.length) {
      this.log('Error: Firmware exceeds flash size');
      return;
    }
    this.flash.set(data, 0x00000);
    this.pc = 0x40000000;
    this.registers.fill(0); // Ensure registers are reset
    this.compareFlag = 0;
    this.serialBuffer = '';
    this.spiBuffer = '';
    this.screenContext.clearRect(0, 0, 320, 240);
    this.screenX = 0;
    this.screenY = 20;
    this.log('Firmware loaded: ' + Array.from(data).join(', '));
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
      this.log(`Error: Unknown opcode: 0x${opcode.toString(16)} at PC: ${this.pc.toString(16)}`);
      this.running = false;
      return;
    }

    const length = this.flash[offset + 1];
    const operands = this.flash.slice(offset + 2, offset + 2 + length);

    this.log(`PC: ${this.pc.toString(16)}, R5 (x) = ${this.registers[5]}, R6 (y) = ${this.registers[6]}, R1 (x+10) = ${this.registers[1]}, R2 (y+10) = ${this.registers[2]}, R7 (dx) = ${this.registers[7]}`);
    this.log(`Firmware at PC: ${Array.from(this.flash.slice(offset, offset + 2 + length)).map(b => b.toString(16).padStart(2, '0')).join(', ')}`);
    this.log(`Executing opcode: 0x${opcode.toString(16)} (length: ${length}) at PC: ${this.pc.toString(16)}`);
    const jumped = instr(...operands);
    const nextPC = jumped ? this.pc : this.pc + 1 + 1 + length;
    this.log(`Next PC: ${nextPC.toString(16)} (jumped: ${jumped})`);
    if (!jumped) {
      this.pc += 1 + 1 + length;
    }
  }

  loadImmediate(reg, value) {
    this.registers[reg] = value;
    this.log(`LDI R${reg} = ${value}`);
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
    this.log(`ADD R${reg1} (${this.registers[reg1]}) + R${reg2} (${this.registers[reg2]})`);
    this.registers[reg1] = (this.registers[reg1] + this.registers[reg2]) & 0xFF;
    this.log(`Result: R${reg1} = ${this.registers[reg1]}`);
    return false;
  }

  sub(reg1, reg2) {
    this.log(`SUB R${reg1} (${this.registers[reg1]}) - R${reg2} (${this.registers[reg2]})`);
    this.registers[reg1] = (this.registers[reg1] - this.registers[reg2]) & 0xFF;
    this.log(`Result: R${reg1} = ${this.registers[reg1]}`);
    return false;
  }

  compare(reg1, reg2) {
    const val1 = this.registers[reg1];
    const val2 = this.registers[reg2];
    this.compareFlag = val1 === val2 ? 0 : val1 > val2 ? 1 : -1;
    this.log(`CMP R${reg1} (${val1}) with R${reg2} (${val2}), compareFlag = ${this.compareFlag}`);
    return false;
  }

  jumpIfEqual(address) {
    this.log(`JEQ to ${address}, compareFlag = ${this.compareFlag}`);
    if (this.compareFlag === 0) {
      this.pc = 0x40000000 + address;
      return true;
    }
    return false;
  }

  jumpIfNotEqual(address) {
    this.log(`JNE to ${address}, compareFlag = ${this.compareFlag}`);
    if (this.compareFlag !== 0) {
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
        for (let i = 0; i < 40000; i++) {
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

    // Parse the code using the dynamically generated parser
    let ast;
    try {
      ast = this.parser.parse(code);
      this.log('AST generated:\n' + JSON.stringify(ast, null, 2));
    } catch (e) {
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

    const varMap = { x: 5, y: 6, dx: 7 }; // Register mapping

    const generateOpcodes = (node) => {
      if (Array.isArray(node)) {
        node.forEach(generateOpcodes);
        return;
      }

      switch (node.type) {
        case "VarDecl":
          if (varMap[node.name]) {
            const value = node.value & 0xFF;
            firmware.push(0x01, 0x02, varMap[node.name], value); // LDI reg, value
            this.log(`Address ${address.toString(16)}: 01, 02, ${varMap[node.name].toString(16).padStart(2, '0')}, ${value.toString(16).padStart(2, '0')} (LDI R${varMap[node.name]}, ${value})`);
            address += 4;
            if (node.name === "x") x = value;
            if (node.name === "y") y = value;
            if (node.name === "dx") dx = value;
          }
          break;

        case "ScreenClear":
          firmware.push(0x1A, 0x00); // CLS
          this.log(`Address ${address.toString(16)}: 1A, 00 (CLS)`);
          address += 2;
          break;

        case "ScreenPixel":
          let xReg = 5, yReg = 6;
          if (node.x.type === "BinaryExpr" && node.x.left === "x") {
            xReg = 1;
            if (!xPlus10Computed) {
              this.log(`Generating x+${node.x.right} computation at address ${address.toString(16)}`);
              firmware.push(0x01, 0x02, 0x01, 0);           // LDI R1, 0
              this.log(`Address ${address.toString(16)}: 01, 02, 01, 00 (LDI R1, 0)`);
              address += 4;
              firmware.push(0x11, 0x02, 0x01, 0x05);        // ADD R1, R5 (R1 = x)
              this.log(`Address ${address.toString(16)}: 11, 02, 01, 05 (ADD R1, R5)`);
              address += 4;
              firmware.push(0x01, 0x02, 0x00, node.x.right); // LDI R0, 10
              this.log(`Address ${address.toString(16)}: 01, 02, 00, ${node.x.right.toString(16).padStart(2, '0')} (LDI R0, ${node.x.right})`);
              address += 4;
              firmware.push(node.x.op === "+" ? 0x11 : 0x12, 0x02, xReg, 0x00); // ADD/SUB R1, R0
              this.log(`Address ${address.toString(16)}: ${node.x.op === "+" ? "11" : "12"}, 02, ${xReg.toString(16).padStart(2, '0')}, 00 (${node.x.op === "+" ? "ADD" : "SUB"} R${xReg}, R0)`);
              address += 4;
              xPlus10Computed = true;
            }
          } else if (node.x === "x") {
            xReg = 5;
          }

          if (node.y.type === "BinaryExpr" && node.y.left === "y") {
            yReg = 2;
            if (!yPlus10Computed) {
              this.log(`Generating y+${node.y.right} computation at address ${address.toString(16)}`);
              firmware.push(0x01, 0x02, 0x02, 0);           // LDI R2, 0
              this.log(`Address ${address.toString(16)}: 01, 02, 02, 00 (LDI R2, 0)`);
              address += 4;
              firmware.push(0x11, 0x02, 0x02, 0x06);        // ADD R2, R6 (R2 = y)
              this.log(`Address ${address.toString(16)}: 11, 02, 02, 06 (ADD R2, R6)`);
              address += 4;
              firmware.push(0x01, 0x02, 0x00, node.y.right); // LDI R0, 10
              this.log(`Address ${address.toString(16)}: 01, 02, 00, ${node.y.right.toString(16).padStart(2, '0')} (LDI R0, ${node.y.right})`);
              address += 4;
              firmware.push(node.y.op === "+" ? 0x11 : 0x12, 0x02, yReg, 0x00); // ADD/SUB R2, R0
              this.log(`Address ${address.toString(16)}: ${node.y.op === "+" ? "11" : "12"}, 02, ${yReg.toString(16).padStart(2, '0')}, 00 (${node.y.op === "+" ? "ADD" : "SUB"} R${yReg}, R0)`);
              address += 4;
              yPlus10Computed = true;
            }
          } else if (node.y === "y") {
            yReg = 6;
          }

          firmware.push(0x1B, 0x02, xReg, yReg); // PIX xReg, yReg
          this.log(`Address ${address.toString(16)}: 1B, 02, ${xReg.toString(16).padStart(2, '0')}, ${yReg.toString(16).padStart(2, '0')} (PIX R${xReg}, R${yReg})`);
          address += 4;
          break;

        case "ScreenMove":
          let xVal = node.x;
          if (xVal.type === "BinaryExpr") {
            // Not supported in this example, but you can extend the grammar
            return;
          } else if (typeof xVal === "string" && varMap[xVal]) {
            xVal = varMap[xVal]; // Use the register for x
          } else {
            xVal = node.x & 0xFF;
            firmware.push(0x01, 0x02, 0x04, xVal); // LDI R4, x
            this.log(`Address ${address.toString(16)}: 01, 02, 04, ${xVal.toString(16).padStart(2, '0')} (LDI R4, ${xVal})`);
            address += 4;
            xVal = 4;
          }
          firmware.push(0x1C, 0x01, xVal); // MOVX xVal
          this.log(`Address ${address.toString(16)}: 1C, 01, ${xVal.toString(16).padStart(2, '0')} (MOVX R${xVal})`);
          address += 3;
          firmware.push(0x01, 0x02, 0x04, node.y & 0xFF); // LDI R4, y
          this.log(`Address ${address.toString(16)}: 01, 02, 04, ${(node.y & 0xFF).toString(16).padStart(2, '0')} (LDI R4, ${node.y & 0xFF})`);
          address += 4;
          firmware.push(0x1D, 0x01, 0x04); // MOVY R4
          this.log(`Address ${address.toString(16)}: 1D, 01, 04 (MOVY R4)`);
          address += 3;
          break;

        case "ScreenPrint":
          for (let char of node.value) {
            firmware.push(0x01, 0x02, 0x00, char.charCodeAt(0)); // LDI R0, char
            this.log(`Address ${address.toString(16)}: 01, 02, 00, ${char.charCodeAt(0).toString(16).padStart(2, '0')} (LDI R0, ${char.charCodeAt(0)})`);
            address += 4;
            firmware.push(0x19, 0x01, 0x00); // SCR R0
            this.log(`Address ${address.toString(16)}: 19, 01, 00 (SCR R0)`);
            address += 3;
          }
          break;

        case "Assignment":
          const varReg = varMap[node.name];
          if (node.op === "=") {
            if (node.value.type === "UnaryExpr" && node.value.op === "-" && node.value.expr === "dx") {
              // Handle dx = -dx
              firmware.push(0x01, 0x02, 0x00, 0);           // LDI R0, 0
              this.log(`Address ${address.toString(16)}: 01, 02, 00, 00 (LDI R0, 0)`);
              address += 4;
              firmware.push(0x12, 0x02, 0x00, 0x07);        // SUB R0, R7 (R0 = 0 - dx)
              this.log(`Address ${address.toString(16)}: 12, 02, 00, 07 (SUB R0, R7)`);
              address += 4;
              firmware.push(0x01, 0x02, varReg, 0);         // LDI R7, 0
              this.log(`Address ${address.toString(16)}: 01, 02, ${varReg.toString(16).padStart(2, '0')}, 00 (LDI R${varReg}, 0)`);
              address += 4;
              firmware.push(0x11, 0x02, varReg, 0x00);      // ADD R7, R0 (R7 = 0 + (0 - dx))
              this.log(`Address ${address.toString(16)}: 11, 02, ${varReg.toString(16).padStart(2, '0')}, 00 (ADD R${varReg}, R0)`);
              address += 4;
              dx = (-dx) & 0xFF;
            } else if (typeof node.value === "number") {
              const value = node.value & 0xFF;
              firmware.push(0x01, 0x02, varReg, value); // LDI reg, value
              this.log(`Address ${address.toString(16)}: 01, 02, ${varReg.toString(16).padStart(2, '0')}, ${value.toString(16).padStart(2, '0')} (LDI R${varReg}, ${value})`);
              address += 4;
              if (node.name === "dx") dx = value;
              if (node.name === "x") {
                x = value;
                xPlus10Computed = false;
                firmware.push(0x01, 0x02, 0x01, 0);           // LDI R1, 0
                this.log(`Address ${address.toString(16)}: 01, 02, 01, 00 (LDI R1, 0)`);
                address += 4;
                firmware.push(0x11, 0x02, 0x01, 0x05);        // ADD R1, R5 (R1 = x)
                this.log(`Address ${address.toString(16)}: 11, 02, 01, 05 (ADD R1, R5)`);
                address += 4;
                firmware.push(0x01, 0x02, 0x00, 10);          // LDI R0, 10
                this.log(`Address ${address.toString(16)}: 01, 02, 00, 0a (LDI R0, 10)`);
                address += 4;
                firmware.push(0x11, 0x02, 0x01, 0x00);        // ADD R1, R0 (R1 = x + 10)
                this.log(`Address ${address.toString(16)}: 11, 02, 01, 00 (ADD R1, R0)`);
                address += 4;
                xPlus10Computed = true;
              }
            }
          } else if (node.op === "+=" && node.value === "dx") {
            firmware.push(0x11, 0x02, varReg, 0x07); // ADD reg, R7 (dx)
            this.log(`Address ${address.toString(16)}: 11, 02, ${varReg.toString(16).padStart(2, '0')}, 07 (ADD R${varReg}, R7)`);
            x = (x + dx) & 0xFF;
            address += 4;
            xPlus10Computed = false;
            firmware.push(0x01, 0x02, 0x01, 0);           // LDI R1, 0
            this.log(`Address ${address.toString(16)}: 01, 02, 01, 00 (LDI R1, 0)`);
            address += 4;
            firmware.push(0x11, 0x02, 0x01, 0x05);        // ADD R1, R5 (R1 = x)
            this.log(`Address ${address.toString(16)}: 11, 02, 01, 05 (ADD R1, R5)`);
            address += 4;
            firmware.push(0x01, 0x02, 0x00, 10);          // LDI R0, 10
            this.log(`Address ${address.toString(16)}: 01, 02, 00, 0a (LDI R0, 10)`);
            address += 4;
            firmware.push(0x11, 0x02, 0x01, 0x00);        // ADD R1, R0 (R1 = x + 10)
            this.log(`Address ${address.toString(16)}: 11, 02, 01, 00 (ADD R1, R0)`);
            address += 4;
            xPlus10Computed = true;
          }
          break;

        case "If":
          const ifReg = varMap[node.left];
          firmware.push(0x01, 0x02, 0x03, node.right & 0xFF); // LDI R3, value
          this.log(`Address ${address.toString(16)}: 01, 02, 03, ${(node.right & 0xFF).toString(16).padStart(2, '0')} (LDI R3, ${node.right & 0xFF})`);
          address += 4;
          firmware.push(0x13, 0x02, ifReg, 0x03); // CMP ifReg, R3
          this.log(`Address ${address.toString(16)}: 13, 02, ${ifReg.toString(16).padStart(2, '0')}, 03 (CMP R${ifReg}, R3)`);
          address += 4;
          const conditionStart = address;
          firmware.push(node.op === ">" ? 0x15 : 0x14, 0x01, 0x00); // JNE/JEQ placeholder
          this.log(`Address ${address.toString(16)}: ${node.op === ">" ? "15" : "14"}, 01, 00 (${node.op === ">" ? "JNE" : "JEQ"} placeholder)`);
          address += 3;
          ifBlocks.push({ start: conditionStart });
          generateOpcodes(node.body);
          const jumpAddr = address;
          firmware[conditionStart + 2] = jumpAddr & 0xFF; // Update JNE/JEQ address
          this.log(`Updated JNE/JEQ at address ${(conditionStart).toString(16)} to jump to ${jumpAddr.toString(16)}`);
          ifBlocks.pop();
          break;

        case "While":
          if (!initializationDone) {
            const initEndAddress = address;
            firmware.push(0x04, 0x01, (initEndAddress + 3) & 0xFF); // JMP to after init
            this.log(`Address ${address.toString(16)}: 04, 01, ${((initEndAddress + 3) & 0xFF).toString(16).padStart(2, '0')} (JMP to after init)`);
            address += 3;
            initializationDone = true;
          }
          loopStart = address;
          xPlus10Computed = false;
          yPlus10Computed = false;
          generateOpcodes(node.body);
          firmware.push(0x16, 0x02, 0xA0, 0x86); // DLY 100000
          this.log(`Address ${address.toString(16)}: 16, 02, A0, 86 (DLY 100000)`);
          address += 4;
          const jumpAddress = address;
          firmware.push(0x04, 0x01, loopStart & 0xFF); // JMP loopStart
          this.log(`Address ${address.toString(16)}: 04, 01, ${(loopStart & 0xFF).toString(16).padStart(2, '0')} (JMP ${loopStart})`);
          address += 3;
          while (ifBlocks.length > 0) {
            const ifBlock = ifBlocks.pop();
            firmware[ifBlock.start + 2] = jumpAddress & 0xFF;
            this.log(`Updated JNE/JEQ at address ${(ifBlock.start).toString(16)} to jump to ${jumpAddress.toString(16)}`);
          }
          loopStart = null;
          break;

        case "Delay":
          firmware.push(0x16, 0x02, node.cycles & 0xFF, (node.cycles >> 8) & 0xFF); // DLY cycles
          this.log(`Address ${address.toString(16)}: 16, 02, ${(node.cycles & 0xFF).toString(16).padStart(2, '0')}, ${((node.cycles >> 8) & 0xFF).toString(16).padStart(2, '0')} (DLY ${node.cycles})`);
          address += 4;
          break;
      }
    };

    generateOpcodes(ast);

    let firmwareLog = 'Firmware bytes:\n';
    for (let i = 0; i < firmware.length; i++) {
      firmwareLog += `Address ${i.toString(16).padStart(2, '0')}: ${firmware[i].toString(16).padStart(2, '0')}\n`;
    }
    this.log(firmwareLog);

    return { success: true, firmware: new Uint8Array(firmware) };
  }
}
