// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { TimerManagerService } from '../../../services/timer-manager/timer-manager.service';
import { createMockLogger } from '../../helpers/logging/mock-logger';

/**
 * Unit Tests for TimerManager Service - Pure Business Logic Only
 * 
 * Following Architecture.md: 10-20% unit tests for pure business logic
 * These tests focus on core timer algorithms and utilities without VS Code dependencies
 */

describe('TimerManager Service - Unit Tests', () => {
    let timerService: TimerManagerService;

    beforeEach(() => {
        const mockLogger = createMockLogger();
        timerService = new TimerManagerService(mockLogger);
    });

    afterEach(() => {
        timerService.dispose();
    });

    describe('Timer Logic - Pure Functions', () => {
        it('should format elapsed time correctly for milliseconds', () => {
            expect(timerService.formatElapsedTime(0)).to.equal('0ms');
            expect(timerService.formatElapsedTime(500)).to.equal('500ms');
            expect(timerService.formatElapsedTime(1234)).to.equal('1234ms');
            expect(timerService.formatElapsedTime(2999)).to.equal('2999ms');
        });

        it('should format elapsed time correctly for seconds', () => {
            expect(timerService.formatElapsedTime(3000)).to.equal('3.0s');
            expect(timerService.formatElapsedTime(3500)).to.equal('3.5s');
            expect(timerService.formatElapsedTime(5000)).to.equal('5.0s');
            expect(timerService.formatElapsedTime(10750)).to.equal('10.8s');
        });

        it('should handle edge case at 3-second boundary', () => {
            expect(timerService.formatElapsedTime(2999)).to.equal('2999ms');
            expect(timerService.formatElapsedTime(3000)).to.equal('3.0s');
            expect(timerService.formatElapsedTime(3001)).to.equal('3.0s');
        });

        it('should handle large time values correctly', () => {
            const oneHour = 3600000; // 1 hour in milliseconds
            expect(timerService.formatElapsedTime(oneHour)).to.equal('3600.0s');
        });

        it('should handle negative time values gracefully', () => {
            expect(timerService.formatElapsedTime(-1000)).to.equal('-1000ms');
        });
    });

    describe('Timer State Management - Core Logic', () => {
        it('should create timer with correct initial state', () => {
            const timer = timerService.startTimer('test-1', 'Test Timer', 'execution');

            expect(timer.id).to.equal('test-1');
            expect(timer.label).to.equal('Test Timer');
            expect(timer.type).to.equal('execution');
            expect(timer.isRunning).to.be.true;
            expect(timer.startTime).to.be.instanceOf(Date);
            expect(timer.endTime).to.be.undefined;
        });

        it('should stop timer and calculate elapsed time', (done) => {
            const timer = timerService.startTimer('test-1');

            // Simulate some time passing
            setTimeout(() => {
                const stoppedTimer = timerService.stopTimer('test-1');

                expect(stoppedTimer).to.not.be.undefined;
                expect(stoppedTimer!.isRunning).to.be.false;
                expect(stoppedTimer!.endTime).to.be.instanceOf(Date);
                expect(stoppedTimer!.elapsedTime).to.be.greaterThan(0);
                done();
            }, 10);
        });

        it('should handle multiple timers correctly', () => {
            const timer1 = timerService.startTimer('timer-1', 'First', 'execution');
            const timer2 = timerService.startTimer('timer-2', 'Second', 'batch');

            expect(timerService.isRunning('timer-1')).to.be.true;
            expect(timerService.isRunning('timer-2')).to.be.true;

            const activeTimers = timerService.getActiveTimers();
            expect(activeTimers).to.have.length(2);
        });

        it('should filter timers by type correctly', () => {
            timerService.startTimer('exec-1', 'Execution 1', 'execution');
            timerService.startTimer('batch-1', 'Batch 1', 'batch');
            timerService.startTimer('custom-1', 'Custom 1', 'custom');

            timerService.clearAllTimers('execution');

            expect(timerService.getTimer('exec-1')).to.be.undefined;
            expect(timerService.getTimer('batch-1')).to.not.be.undefined;
            expect(timerService.getTimer('custom-1')).to.not.be.undefined;
        });
    });

    describe('Timer Pause/Resume Logic', () => {
        it('should pause and resume timer correctly', (done) => {
            const timer = timerService.startTimer('test-1');

            // Simulate time passing
            setTimeout(() => {
                const pauseResult = timerService.pauseTimer('test-1');
                expect(pauseResult).to.be.true;
                expect(timerService.isPaused('test-1')).to.be.true;
                expect(timerService.isRunning('test-1')).to.be.false;

                const resumeResult = timerService.resumeTimer('test-1');
                expect(resumeResult).to.be.true;
                expect(timerService.isPaused('test-1')).to.be.false;
                expect(timerService.isRunning('test-1')).to.be.true;
                done();
            }, 10);
        });

        it('should handle pause/resume edge cases', () => {
            // Pause non-existent timer
            expect(timerService.pauseTimer('non-existent')).to.be.false;

            // Resume non-existent timer
            expect(timerService.resumeTimer('non-existent')).to.be.false;

            // Pause already stopped timer
            const timer = timerService.startTimer('test-1');
            timerService.stopTimer('test-1');
            expect(timerService.pauseTimer('test-1')).to.be.false;
        });
    });

    describe('Callback Management - Core Logic', () => {
        it('should register and unregister callbacks correctly', () => {
            let callbackCount = 0;

            const unregister = timerService.onTimerUpdate(() => {
                callbackCount++;
            });

            // Start timer to trigger callback
            timerService.startTimer('test-1');

            expect(callbackCount).to.equal(1);

            // Unregister and start another timer
            unregister();
            timerService.startTimer('test-2');

            // Callback count should not increase
            expect(callbackCount).to.equal(1);
        });

        it('should handle callback errors gracefully', () => {
            // Register callback that throws error
            timerService.onTimerUpdate(() => {
                throw new Error('Test callback error');
            });

            // Starting timer should not throw error despite callback error
            expect(() => timerService.startTimer('test-1')).to.not.throw();
        });
    });

    describe('Memory Management - Core Logic', () => {
        it('should clear individual timers correctly', () => {
            timerService.startTimer('timer-1');
            timerService.startTimer('timer-2');

            expect(timerService.clearTimer('timer-1')).to.be.true;
            expect(timerService.getTimer('timer-1')).to.be.undefined;
            expect(timerService.getTimer('timer-2')).to.not.be.undefined;

            // Clearing non-existent timer should return false
            expect(timerService.clearTimer('timer-1')).to.be.false;
        });

        it('should clear all timers correctly', () => {
            timerService.startTimer('timer-1', 'Timer 1', 'execution');
            timerService.startTimer('timer-2', 'Timer 2', 'batch');

            timerService.clearAllTimers();

            expect(timerService.getAllTimers()).to.have.length(0);
            expect(timerService.getActiveTimers()).to.have.length(0);
        });
    });
});