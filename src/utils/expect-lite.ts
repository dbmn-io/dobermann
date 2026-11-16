// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Lightweight expect implementation for API testing
 * Replaces chai dependency to reduce extension size
 * 
 * Provides common assertion methods used in API response testing:
 * - expect(value).to.equal(expected)
 * - expect(value).to.include(substring) 
 * - expect(value).to.exist
 * - expect(value).to.be.true/false
 * - expect(value).to.have.property(prop)
 * - expect(value).to.match(regex)
 * - expect(value).to.have.lengthOf(n)
 * - expect(value).greaterThan(n) / lessThan(n)
 */

class Expectation {
  private actual: any;
  private negated: boolean = false;
  
  constructor(actual: any) {
    this.actual = actual;
  }
  
  get to() { return this; }
  get be() { return this; }
  get have() { return this; }
  get not() { 
    this.negated = true;
    return this;
  }
  
  equal(expected: any) {
    const passed = this.actual === expected;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} ${this.negated ? 'not ' : ''}to equal ${expected}`);
    }
    return this;
  }
  
  equals(expected: any) { return this.equal(expected); }
  eq(expected: any) { return this.equal(expected); }
  
  include(value: any) {
    const passed = String(this.actual).includes(value);
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} ${this.negated ? 'not ' : ''}to include ${value}`);
    }
    return this;
  }
  
  contain(value: any) { return this.include(value); }
  contains(value: any) { return this.include(value); }
  
  get exist() {
    const passed = this.actual != null;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected value ${this.negated ? 'not ' : ''}to exist`);
    }
    return this;
  }
  
  property(prop: string, value?: any) {
    const hasProp = this.actual != null && prop in this.actual;
    if (this.negated ? hasProp : !hasProp) {
      throw new Error(`Expected object ${this.negated ? 'not ' : ''}to have property ${prop}`);
    }
    if (value !== undefined && this.actual[prop] !== value) {
      throw new Error(`Expected property ${prop} to equal ${value}, got ${this.actual[prop]}`);
    }
    return this;
  }
  
  greaterThan(value: number) {
    const passed = this.actual > value;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} ${this.negated ? 'not ' : ''}to be greater than ${value}`);
    }
    return this;
  }
  
  gt(value: number) { return this.greaterThan(value); }
  above(value: number) { return this.greaterThan(value); }
  
  lessThan(value: number) {
    const passed = this.actual < value;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} ${this.negated ? 'not ' : ''}to be less than ${value}`);
    }
    return this;
  }
  
  lt(value: number) { return this.lessThan(value); }
  below(value: number) { return this.lessThan(value); }
  
  get true() {
    if (this.negated ? this.actual === true : this.actual !== true) {
      throw new Error(`Expected ${this.actual} to be ${this.negated ? 'not ' : ''}true`);
    }
    return this;
  }
  
  get false() {
    if (this.negated ? this.actual === false : this.actual !== false) {
      throw new Error(`Expected ${this.actual} to be ${this.negated ? 'not ' : ''}false`);
    }
    return this;
  }
  
  match(regex: RegExp) {
    const passed = regex.test(String(this.actual));
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} ${this.negated ? 'not ' : ''}to match ${regex}`);
    }
    return this;
  }
  
  lengthOf(length: number) {
    const actualLength = this.actual?.length ?? 0;
    if (this.negated ? actualLength === length : actualLength !== length) {
      throw new Error(`Expected length ${this.negated ? 'not ' : ''}to be ${length}, got ${actualLength}`);
    }
    return this;
  }
  
  get length() {
    return {
      greaterThan: (n: number) => {
        const actualLength = this.actual?.length ?? 0;
        const passed = actualLength > n;
        if (this.negated ? passed : !passed) {
          throw new Error(`Expected length ${actualLength} ${this.negated ? 'not ' : ''}to be greater than ${n}`);
        }
        return this;
      },
      lessThan: (n: number) => {
        const actualLength = this.actual?.length ?? 0;
        const passed = actualLength < n;
        if (this.negated ? passed : !passed) {
          throw new Error(`Expected length ${actualLength} ${this.negated ? 'not ' : ''}to be less than ${n}`);
        }
        return this;
      }
    };
  }
  
  // Common type checking
  get ok() {
    const passed = Boolean(this.actual);
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} to be ${this.negated ? 'not ' : ''}truthy`);
    }
    return this;
  }
  
  get undefined() {
    const passed = this.actual === undefined;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} to be ${this.negated ? 'not ' : ''}undefined`);
    }
    return this;
  }
  
  get null() {
    const passed = this.actual === null;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected ${this.actual} to be ${this.negated ? 'not ' : ''}null`);
    }
    return this;
  }
  
  // HTTP status code helpers (common in API testing)
  get successful() {
    const passed = this.actual >= 200 && this.actual < 300;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected status ${this.actual} to be ${this.negated ? 'not ' : ''}successful (2xx)`);
    }
    return this;
  }
  
  get clientError() {
    const passed = this.actual >= 400 && this.actual < 500;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected status ${this.actual} to be ${this.negated ? 'not ' : ''}a client error (4xx)`);
    }
    return this;
  }
  
  get serverError() {
    const passed = this.actual >= 500 && this.actual < 600;
    if (this.negated ? passed : !passed) {
      throw new Error(`Expected status ${this.actual} to be ${this.negated ? 'not ' : ''}a server error (5xx)`);
    }
    return this;
  }
}

/**
 * Create an expectation for the given value
 * @param actual The value to test
 * @returns Expectation object with assertion methods
 */
export function expect(actual: any): Expectation {
  return new Expectation(actual);
}

// Export for compatibility with existing code
export default expect;