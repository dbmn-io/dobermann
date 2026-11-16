// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which failed pages of Fetch all are asked for again (page-retry.ts): the temporary ones only.
 */
import { expect } from 'chai';
import { PAGE_RETRY_DELAYS_MS, isTemporaryPageFailure } from '../../../services/pagination/page-retry';

describe('Fetch all: a page that fails for a moment', () => {
    it('is asked for again on a busy or failing server, or when no answer came', () => {
        for (const httpStatus of [429, 500, 502, 503, 504]) expect(isTemporaryPageFailure({ success: false, httpStatus }), String(httpStatus)).to.equal(true);
        expect(isTemporaryPageFailure({ success: false }), 'no answer').to.equal(true);
        expect(isTemporaryPageFailure({ success: false, httpStatus: 0 }), 'no status').to.equal(true);
    });

    it('is not, when it would only fail the same way, succeeded, or was cancelled', () => {
        for (const httpStatus of [400, 401, 403, 404, 409, 422]) expect(isTemporaryPageFailure({ success: false, httpStatus }), String(httpStatus)).to.equal(false);
        expect(isTemporaryPageFailure({ success: true, httpStatus: 200 })).to.equal(false);
        expect(isTemporaryPageFailure({ success: false, cancelled: true }), 'Cancel').to.equal(false);
    });

    it('twice more at most, a second then three apart', () => {
        expect([...PAGE_RETRY_DELAYS_MS]).to.deep.equal([1_000, 3_000]);
    });
});
