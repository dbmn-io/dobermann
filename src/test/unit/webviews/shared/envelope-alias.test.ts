// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createConsoleTableBuilder } = require('../../../../webviews/shared/console-table-builder');

// Phase 1B.9 — display-only alias for the envelope `data` wrapper field.
// Leading `data` segment swaps to `body`; deeper occurrences and non-envelope
// paths pass through unchanged. Internal storage/paths are not affected.
describe('console-table-builder — aliasEnvelopeDataPath (Phase 1B.9)', () => {
    let builder: ReturnType<typeof createConsoleTableBuilder>;

    beforeEach(() => {
        builder = createConsoleTableBuilder();
    });

    it('aliases the bare envelope data field', () => {
        expect(builder.aliasEnvelopeDataPath('data')).to.equal('body');
    });

    it('aliases the leading data segment of a dotted path', () => {
        expect(builder.aliasEnvelopeDataPath('data.data')).to.equal('body.data');
        expect(builder.aliasEnvelopeDataPath('data.lines.x')).to.equal('body.lines.x');
        expect(builder.aliasEnvelopeDataPath('data.data.gln')).to.equal('body.data.gln');
    });

    it('passes envelope siblings through unchanged', () => {
        expect(builder.aliasEnvelopeDataPath('status')).to.equal('status');
        expect(builder.aliasEnvelopeDataPath('metadata.sourceFile')).to.equal('metadata.sourceFile');
        expect(builder.aliasEnvelopeDataPath('httpStatus')).to.equal('httpStatus');
        expect(builder.aliasEnvelopeDataPath('headers')).to.equal('headers');
    });

    it('leaves the rowBasis sentinel "root" alone', () => {
        expect(builder.aliasEnvelopeDataPath('root')).to.equal('root');
    });

    it('only aliases the LEADING data segment (deeper "data" stays)', () => {
        // The envelope wrapper is only at the TOP level; deeper occurrences are
        // the user's own API naming and must not be renamed.
        expect(builder.aliasEnvelopeDataPath('metadata.data')).to.equal('metadata.data');
        expect(builder.aliasEnvelopeDataPath('headers.data.value')).to.equal('headers.data.value');
    });

    it('does not match a prefix that only starts with "data" (e.g. dataId)', () => {
        expect(builder.aliasEnvelopeDataPath('dataId')).to.equal('dataId');
        expect(builder.aliasEnvelopeDataPath('dataset.x')).to.equal('dataset.x');
    });

    it('returns empty and non-strings unchanged (defensive)', () => {
        expect(builder.aliasEnvelopeDataPath('')).to.equal('');
        expect(builder.aliasEnvelopeDataPath(null)).to.equal(null);
        expect(builder.aliasEnvelopeDataPath(undefined)).to.equal(undefined);
    });
});
