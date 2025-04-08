export const firmware = new Uint8Array([
  0x01, 0x00, 0x01,  // LDI R0, 1    - Load 1 into R0
  0x02, 0x00, 0x02,  // STG R0, 2    - Set GPIO 2 high
  0x01, 0x00, 0x48,  // LDI R0, 72   - Load 'H' into R0
  0x05, 0x00,        // SER R0       - Write 'H' to serial
  0x01, 0x00, 0x41,  // LDI R0, 65   - Load 'A' into R0
  0x19, 0x00,        // SCR R0       - Print 'A' to screen
  0x01, 0x00, 0x00,  // LDI R0, 0    - Load 0 into R0
  0x02, 0x00, 0x02,  // STG R0, 2    - Set GPIO 2 low
  0x01, 0x00, 0x4C,  // LDI R0, 76   - Load 'L' into R0
  0x05, 0x00,        // SER R0       - Write 'L' to serial
  0x01, 0x00, 0x42,  // LDI R0, 66   - Load 'B' into R0
  0x19, 0x00,        // SCR R0       - Print 'B' to screen
  0x16, 0x10, 0x27,  // DLY 10000    - Delay 10000 cycles
  0x04, 0x00, 0x00,  // JMP 0        - Loop back to start
]);