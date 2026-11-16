// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LineBlock = require('../../../../webviews/shared/line-block');

// Ctrl+D on a line that opens an object or array deletes the whole block
// (Puppy School Lesson 5: delete `buyer` and `supplier` from a copied order).

/** Apply findBlock's result the way endpoint.js does, and return the new text. */
function ctrlD(text: string, lineNumber: number): string | null {
    const lines = text.split('\n');
    const block = LineBlock.findBlock(lines, lineNumber);
    if (!block) return null;
    if (block.commaAt) {
        const l = lines[block.commaAt.line - 1];
        lines[block.commaAt.line - 1] = l.slice(0, block.commaAt.column - 1) + l.slice(block.commaAt.column);
    }
    lines.splice(block.startLine - 1, block.endLine - block.startLine + 1);
    return lines.join('\n');
}

const ORDER = `{
  "id": "000ddfad",
  "buyer": {
    "gln": "5012345000039",
    "name": "The Paw Print Trading Company"
  },
  "supplier": {
    "gln": "4012345000054",
    "name": "K9 Precision Parts Corp"
  },
  "lines": [
    {
      "sku": "SKU-WOOF-004"
    }
  ]
}`;

describe('line-block — Ctrl+D deletes the block a line opens', () => {
    it('deletes a nested object, opening line to closing brace', () => {
        const out = ctrlD(ORDER, 3);
        expect(out).to.not.include('buyer');
        expect(out).to.include('"supplier": {');
        expect(() => JSON.parse(out as string)).to.not.throw();
    });

    it('deletes both lookup objects in turn and leaves valid JSON', () => {
        let out = ctrlD(ORDER, 3) as string;
        out = ctrlD(out, 3) as string;
        expect(JSON.parse(out)).to.deep.equal({ id: '000ddfad', lines: [{ sku: 'SKU-WOOF-004' }] });
    });

    it('deletes an array block', () => {
        const out = ctrlD(ORDER, 11) as string;
        expect(out).to.not.include('lines');
        // `lines` was the last member: the comma before it goes too.
        expect(JSON.parse(out)).to.have.keys('id', 'buyer', 'supplier');
    });

    it('removes the dangling comma when the block was the last member, skipping comments', () => {
        const text = `{
  "a": 1, //note
  // "b": 2,
  "c": {
    "d": 1
  }
}`;
        const out = ctrlD(text, 4) as string;
        expect(out).to.equal(`{
  "a": 1 //note
  // "b": 2,
}`);
    });

    it('returns null for a plain key-value line, so Ctrl+D deletes just that line', () => {
        expect(LineBlock.findBlock(ORDER.split('\n'), 2)).to.equal(null);
        expect(LineBlock.findBlock(ORDER.split('\n'), 5)).to.equal(null);
    });

    it('returns null for a line that opens and closes on itself', () => {
        expect(LineBlock.findBlock(['{', '  "a": { "b": 1 },', '}'], 2)).to.equal(null);
    });

    it('ignores braces inside strings, template variables and comments', () => {
        const text = `{
  "x": {
    "s": "has } and ] in it",
    "t": "{{sku:string}}", //was {
    "u": {{qty:number}}
  },
  "y": 1
}`;
        const block = LineBlock.findBlock(text.split('\n'), 2);
        expect(block).to.deep.equal({ startLine: 2, endLine: 6, commaAt: null });
    });

    it('returns null when the block never closes', () => {
        expect(LineBlock.findBlock(['{', '  "a": {', '    "b": 1'], 2)).to.equal(null);
    });
});
