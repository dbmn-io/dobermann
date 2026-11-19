// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Environment webview JavaScript
(function() {
    const vscode = acquireVsCodeApi();
    window.vscode = vscode; // Make vscode globally accessible for documentation-helpers.js

    // Hydrate icon placeholders + wire the window-controls cluster (min/max/close).
    if (window.EditorWindowControls) window.EditorWindowControls.wire(vscode);
    let decodedToken = null;
    let currentActualToken = null; // Store actual token for copying
    let currentEnvironmentId = '';
    let currentEnvironmentFolder = ''; // Track folder internally even though not shown in UI
    let isNewEnvironment = !currentEnvironmentId || currentEnvironmentId === '';
    let hasUnsavedChanges = false;
    /** The environment came with OAuth settings of its own (see applyOAuthDefaults). */
    let hadOAuthConfig = false;
    let savedFormStateJson = ''; // JSON representation of saved form state
    let isLoadingEnvironment = false; // Flag to prevent change detection during loading
    let currentTab = 'environment';
    let activeNotificationTimeout = null; // Footer notification auto-hide timer
    let jwtDecodeTimeout = null; // Debounce timer for auto-decoding JWT tokens
    let currentTokenView = 'decoded'; // Track active view: 'decoded' or 'encoded'

    /**
     * Switch between Environment, Authentication, and Configuration tabs
     */
    function switchTab(tabName) {
        document.querySelectorAll('#environment-tabs .tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.add('hidden');
        });
        const target = document.getElementById(`tab-panel-${tabName}`);
        if (target) {
            target.classList.remove('hidden');
        }
        currentTab = tabName;
    }

    /** #415: the Systems the picker lists, for the heading's System name. */
    let envSystems = [];
    let envBaseUrlLocked = false;

    /**
     * #415: once the System and the URL are both fixed, they are the section's heading,
     * "System: URL", in place of their rows; nothing there to change, so nothing to explain.
     * Otherwise (a new environment opened without the dialog, an older one with no System yet)
     * the rows stay, with their notes.
     */
    function refreshDetailsHeading() {
        const heading = document.getElementById('envDetailsHeading');
        if (!heading) return;
        const url = (document.getElementById('envBaseUrl')?.value || '').trim();
        const selected = envSystemPicker ? envSystemPicker.getSelected() : undefined;
        const system = envSystems.find(s => s.id === selected);
        const fixed = envBaseUrlLocked && envSystemLocked && !!system && !!url;
        heading.textContent = fixed ? `${system.name}: ${envFixedBaseUrl || url}` : 'Environment Details';
        const systemRow = document.getElementById('envSystemRow');
        if (systemRow) systemRow.hidden = fixed;
        const urlRow = document.getElementById('envBaseUrlRow');
        if (urlRow) urlRow.hidden = fixed && !envBaseUrlPathOpen;
        const pencil = document.getElementById('envBaseUrlEdit');
        if (pencil) pencil.hidden = !fixed || envBaseUrlPathOpen;
    }

    /**
     * #424: the URL as it was fixed (the dialog's, or the saved one), and whether its row is open
     * again to change the path. The host never changes (environment-url.ts baseUrlProblem says
     * so on save too).
     */
    let envFixedBaseUrl = '';
    let envBaseUrlPathOpen = false;
    function editBaseUrlPath() {
        envBaseUrlPathOpen = true;
        refreshDetailsHeading();
        const field = document.getElementById('envBaseUrl');
        if (field) {
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
        }
    }

    /** `protocol//host[:port]` of a URL that may hold {{variables}} in its path; '' when unparseable. */
    function urlOrigin(url) {
        try { return new URL(url).origin.toLowerCase(); } catch (e) { return ''; }
    }

    /**
     * GitHub Issue #160: Lock/unlock baseUrl field. Locked, its host is fixed (the environment's
     * identity) and the row closes into the heading; #424: its path may still change, from the
     * heading's pencil. A batch keeps the URL it started with, so a change never moves one.
     */
    function setBaseUrlLocked(locked) {
        const baseUrlField = document.getElementById('envBaseUrl');
        const hintElement = document.getElementById('envBaseUrlHint');
        const lockedElement = document.getElementById('envBaseUrlLocked');

        if (hintElement) {
            hintElement.hidden = locked;
        }
        if (lockedElement) {
            lockedElement.hidden = !locked;
        }
        envBaseUrlLocked = locked;
        envFixedBaseUrl = locked && baseUrlField ? baseUrlField.value.trim() : '';
        envBaseUrlPathOpen = false;
        refreshDetailsHeading();
    }

    /**
     * #415: an environment's System is fixed after creation, like its URL. An older environment
     * saved with no System stays open until it is saved with one. Remembered here because the
     * environment can load before the picker exists (the systemsList message comes separately).
     */
    let envSystemLocked = false;
    function setSystemLocked(locked) {
        envSystemLocked = locked;
        if (envSystemPicker) envSystemPicker.setLocked(locked);
        const lockedElement = document.getElementById('envSystemLocked');
        if (lockedElement) lockedElement.hidden = !locked;        refreshDetailsHeading();
    }

    // Send ready message when loaded
    window.addEventListener('load', () => {
        // Reset environment context - check if this is a new environment
        if (!currentEnvironmentId || currentEnvironmentId === '') {
            // This is a new environment
            resetEnvironmentContext();
        }

        vscode.postMessage({ type: 'ready' });
        setupFormChangeTracking();

        // Initialize help icons
        if (window.initializeAllHelpIcons) {
            window.initializeAllHelpIcons();
        } else {
            console.error('[Environment] initializeAllHelpIcons is not defined!');
        }

        // Note: Environment data loading is handled by the extension's initializeWebview()
        // method, which is triggered by the 'ready' message above
    });

    function resetEnvironmentContext() {
        // Clear form for new environment
        document.getElementById('envName').value = '';
        document.getElementById('envType').value = 'development'; // Default to development
        document.getElementById('envBaseUrl').value = ''; // Clear URL for new environment
        document.getElementById('envDescription').value = '';

        // GitHub Issue #160: Unlock baseUrl for new environment creation
        setBaseUrlLocked(false);
        setSystemLocked(false);

        // Clear parallel processing fields
        document.getElementById('maxConcurrency').value = '1';

        // Clear headers and variables tables (Issue #126)
        const headersBody = document.getElementById('headersTableBody');
        if (headersBody) headersBody.innerHTML = '';
        const variablesBody = document.getElementById('variablesTableBody');
        if (variablesBody) variablesBody.innerHTML = '';

        // Clear internal state
        currentEnvironmentFolder = '';
        
        // Update UI for new environment
        const activateBtn = document.getElementById('activateBtn');
        const deleteBtn = document.getElementById('deleteEnvBtn');

        if (activateBtn) hideElement(activateBtn);
        if (deleteBtn) hideElement(deleteBtn);
        
        // Clear token displays
        clearTokenDetails();
        clearFooterNotification();

        isNewEnvironment = true;
        hadOAuthConfig = false;
    }

    function setupFormChangeTracking() {
        // Store initial form state
        captureInitialFormState();
        
        // Add change listeners to form fields
        const formFields = ['envName', 'envType', 'envDescription', 'envBaseUrl'];
        formFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.addEventListener('input', () => {
                    checkForChanges();
                    updateTitle();
                    // Auto-detect OAuth URLs when base URL changes
                    if (fieldId === 'envBaseUrl') {
                        autoDetectOAuthUrls();
                    }
                });
            }
        });

        
        // Add change listeners for parallel processing fields

        const maxConcurrencySelect = document.getElementById('maxConcurrency');
        if (maxConcurrencySelect) {
            maxConcurrencySelect.addEventListener('change', () => {
                checkForChanges();
                updateTitle();
            });
        }

        // #344: where this environment's runs happen
        document.getElementById('runOn')?.addEventListener('change', () => {
            applyRunOnNote();
            applySecretsPlacement();
            checkForChanges();
            updateTitle();
        });

        // GitHub Issue #162: Add change listener for target timezone
        const targetTimezoneSelect = document.getElementById('targetTimezone');
        if (targetTimezoneSelect) {
            targetTimezoneSelect.addEventListener('change', () => {
                checkForChanges();
                updateTitle();
            });
        }

        // Add change listener for JWT token field
        const jwtTokenField = document.getElementById('jwtToken');
        if (jwtTokenField) {
            jwtTokenField.addEventListener('input', () => {
                checkForChanges();
                updateTitle();
                // Auto-decode JWT token client-side after 500ms of no typing
                if (jwtDecodeTimeout) clearTimeout(jwtDecodeTimeout);
                jwtDecodeTimeout = setTimeout(() => {
                    const token = jwtTokenField.value.trim();
                    if (token) {
                        decodeJwtClientSide(token);
                    } else {
                        clearTokenDetails();
                        clearFooterNotification();
                    }
                }, 500);
            });
        }

        // Add real-time validation for OAuth fields
        const oauthFields = ['clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl', 'scopes'];
        oauthFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                // Clear error styling when user starts typing
                field.addEventListener('input', () => {
                    clearFieldError(fieldId);
                    checkForChanges();
                    updateTitle();
                });
                
                // Validate on blur (when field loses focus)
                field.addEventListener('blur', () => {
                    const authMethod = document.getElementById('authMethod').value;
                    const value = field.value.trim();
                    
                    // Only validate OAuth fields when OAuth method is selected
                    if (authMethod !== 'oauth') {
                        return;
                    }
                    
                    // Check if this specific field is required
                    let isRequired = ['clientId', 'authorizationUrl', 'tokenUrl'].includes(fieldId);
                    // Client secret is optional for most OAuth providers
                    if (fieldId === 'clientSecret') {
                        isRequired = false; // Make client secret optional
                    }
                    
                    // Clear previous error
                    clearFieldError(fieldId);
                    
                    // Validate the field
                    const errorMessage = getFieldValidationMessage(fieldId, value);
                    if (errorMessage) {
                        markFieldError(fieldId);
                        // Could show tooltip or other UI feedback here
                    }
                });
            }
        });
        
        // Handle authentication method changes
        const authMethodField = document.getElementById('authMethod');
        if (authMethodField) {
            authMethodField.addEventListener('change', () => {
                handleAuthMethodChange();
            });
        }
        
        // Add change listeners for the OAuth dropdowns
        ['oauthFlow', 'clientAuth'].forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.addEventListener('change', () => {
                    checkForChanges();
                    updateTitle();
                });
            }
        });
    }

    function getCurrentFormState() {
        return {
            envName: document.getElementById('envName')?.value || '',
            envType: document.getElementById('envType')?.value || 'development',
            envBaseUrl: document.getElementById('envBaseUrl')?.value || '',
            envDescription: document.getElementById('envDescription')?.value || '',
            authMethod: document.getElementById('authMethod')?.value || '',
            jwtToken: document.getElementById('jwtToken')?.value || '',
            clientId: document.getElementById('clientId')?.value || '',
            clientSecret: document.getElementById('clientSecret')?.value || '',
            authorizationUrl: document.getElementById('authorizationUrl')?.value || '',
            tokenUrl: document.getElementById('tokenUrl')?.value || '',
            oauthFlow: document.getElementById('oauthFlow')?.value || '',
            clientAuth: document.getElementById('clientAuth')?.value || 'body',
            scopes: document.getElementById('scopes')?.value || '',
            maxConcurrency: document.getElementById('maxConcurrency')?.value || '1',
            // GitHub Issue #162: Target timezone for datetime values
            targetTimezone: document.getElementById('targetTimezone')?.value || 'UTC',
            runOn: document.getElementById('runOn')?.value || 'browser',
            // P0.2: System assignment is part of the form state so changing
            // it via the picker enables Save just like any other field.
            systemId: (typeof envSystemPicker !== 'undefined' && envSystemPicker)
                ? (envSystemPicker.getSelected() || '')
                : '',
            // Include headers and variables for change tracking (Issue #126)
            headers: JSON.stringify(getHeadersFromTable()),
            variables: JSON.stringify(getVariablesFromTable()),
            // #424: a variable's Options and Header tick are changes too (they were not, so
            // editing them left Save disabled)
            variableSettings: JSON.stringify(getVariableSettingsFromTable())
        };
    }

    function captureInitialFormState() {
        savedFormStateJson = JSON.stringify(getCurrentFormState());
    }

    function checkForChanges() {
        const currentFormStateJson = JSON.stringify(getCurrentFormState());
        hasUnsavedChanges = currentFormStateJson !== savedFormStateJson;

        updateTitle();
    }

    function updateTitle() {
        const title = document.querySelector('h2');
        if (title) {
            const baseTitle = 'Environment Management';
            title.textContent = hasUnsavedChanges ? baseTitle + ' *' : baseTitle;
        }
        
        // Update button states based on unsaved changes
        updateButtonStates();
    }
    
    function updateButtonStates() {
        const saveBtn = document.getElementById('saveEnvBtn');
        const activateBtn = document.getElementById('activateBtn');
        const signInBtn = document.getElementById('signInBtn');
        const signOutBtn = document.getElementById('signOutBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const requestTokenBtn = document.getElementById('requestTokenBtn');

        // Save button: enabled when there are unsaved changes
        if (saveBtn) {
            saveBtn.disabled = !hasUnsavedChanges;
        }
        // The footer's few words (dbmn-status): saved, or not yet
        const status = document.getElementById('envStatus');
        if (status) {
            const isNew = !currentEnvironmentId;
            status.textContent = hasUnsavedChanges ? 'Not saved yet' : isNew ? 'New: not saved yet' : 'Saved';
            if (hasUnsavedChanges || isNew) status.setAttribute('tone', 'warn'); else status.setAttribute('tone', 'ok');
        }

        // Set as Active button: disabled when there are unsaved changes
        if (activateBtn) {
            activateBtn.disabled = hasUnsavedChanges;
        }

        // Auth buttons: disabled when there are unsaved changes
        if (signInBtn) {
            signInBtn.disabled = hasUnsavedChanges;
        }
        if (signOutBtn) {
            signOutBtn.disabled = hasUnsavedChanges;
        }
        if (refreshBtn) {
            refreshBtn.disabled = hasUnsavedChanges;
        }
        if (requestTokenBtn) {
            requestTokenBtn.disabled = hasUnsavedChanges;
        }
    }

    function resetChangeTracking() {
        captureInitialFormState();
        hasUnsavedChanges = false;
        updateTitle();
        updateButtonStates();
    }

    // Helper functions for showing/hiding elements with CSS classes
    function showElement(element) {
        if (element) {
            element.classList.remove('hidden');
        }
    }
    
    function hideElement(element) {
        if (element) {
            element.classList.add('hidden');
        }
    }

    // Authentication Method Change Handler
    /**
     * #344 (web app only): an environment that runs in DBMN for VS Code keeps its secrets there.
     * Its secret fields give way to a note saying where to enter them; a Browser environment's
     * secrets get a reminder that they stay in this browser. VS Code shows the fields as always.
     */
    const HOST = document.querySelector('meta[name="dbmn-host"]')?.content;
    const IS_WEB = HOST === 'web';
    const SECRET_FIELDS = { token: 'jwtTokenGroup', 'client secret': 'clientSecretGroup', 'service account key': 'serviceAccountJsonGroup' };

    // "Run in" is only the web app's for now. VS Code and the desktop app are local agents
    // themselves and send every request, whatever it says; it's saved with the environment, so
    // they show it, and say so (Cloud worker will be theirs too). The web app's local agent is
    // DBMN for VS Code: said when it's picked.
    // "Store results in": VS Code keeps everything on this machine, so it hides that one. Both
    // values load and save unchanged.
    function applyRunOnNote() {
        const note = document.getElementById('runOnHostNote');
        if (!note) return;
        if (!IS_WEB) {
            note.textContent = `${HOST === 'desktop' ? 'This app' : 'DBMN for VS Code'} is a local agent: it sends every request itself.`;
            note.classList.remove('hidden');
            return;
        }
        const select = document.getElementById('runOn');
        note.textContent = 'Local agent: requests are sent from DBMN for VS Code on this computer. Keep it open and signed in.';
        note.classList.toggle('hidden', select?.value !== 'local-agent' || !!select?.disabled);
    }
    applyRunOnNote();
    if (HOST !== 'web' && HOST !== 'desktop') {
        document.getElementById('storeResultsInRow')?.classList.add('hidden');
    }

    function applySecretsPlacement() {
        if (!IS_WEB) return;
        const inAgent = document.getElementById('runOn')?.value === 'local-agent';
        const name = document.getElementById('envName')?.value.trim() || 'this environment';
        for (const [what, groupId] of Object.entries(SECRET_FIELDS)) {
            document.getElementById(groupId)?.classList.toggle('hidden', inAgent);
            const note = document.querySelector(`[data-secret-note="${what}"]`);
            if (!note) continue;
            note.classList.toggle('hidden', !inAgent);
            note.querySelector('.secret-note-text').textContent =
                `The ${what} is kept in DBMN for VS Code, not in the browser: this environment runs there. ` +
                `To enter or change it, open DBMN for VS Code → Environments → ${name} → Authentication. ` +
                `A copy saved in this browser is removed when you save.`;
        }
        const method = document.getElementById('authMethod')?.value;
        const hasSecrets = method === 'jwt' || method === 'oauth' || method === 'google-service-account';
        document.getElementById('secretsInBrowserNote')?.classList.toggle('hidden', inAgent || !hasSecrets);
    }

    function handleAuthMethodChange() {
        applySecretsPlacement();
        const authMethod = document.getElementById('authMethod').value;
        const noAuthConfig = document.getElementById('noAuthConfig');
        const jwtConfig = document.getElementById('jwtConfig');
        const oauthConfig = document.getElementById('oauthConfig');
        const serviceAccountConfig = document.getElementById('serviceAccountConfig');
        const dbmnAuthConfig = document.getElementById('dbmnAuthConfig');

        // Hide all auth configurations first
        [noAuthConfig, jwtConfig, oauthConfig, serviceAccountConfig, dbmnAuthConfig].forEach(el => {
            if (el) el.classList.add('hidden');
        });

        // Clear footer notification on method switch
        clearFooterNotification();

        // Only fully clear token details when switching to no-auth
        if (authMethod === 'none') {
            clearTokenDetails();
        }

        if (authMethod === 'none') {
            noAuthConfig.classList.remove('hidden');
        } else if (authMethod === 'jwt') {
            jwtConfig.classList.remove('hidden');
        } else if (authMethod === 'oauth') {
            oauthConfig.classList.remove('hidden');

            // Auto-detect OAuth URLs when switching to OAuth
            autoDetectOAuthUrls();

            // Request OAuth status check for saved environment (this will handle button visibility)
            if (currentEnvironmentId && !isNewEnvironment) {
                vscode.postMessage({
                    type: 'checkOAuthStatus',
                    environmentId: currentEnvironmentId
                });
            }
        } else if (authMethod === 'google-service-account') {
            if (serviceAccountConfig) serviceAccountConfig.classList.remove('hidden');
        } else if (authMethod === 'dbmn') {
            if (dbmnAuthConfig) dbmnAuthConfig.classList.remove('hidden');
        }

        // Update auth button visibility based on auth method
        updateAuthButtonVisibility(authMethod);

        // Restore token details for auth methods that use tokens
        if (authMethod !== 'none' && currentActualToken) {
            showTokenDetails(currentActualToken, decodedToken);
            if (authMethod === 'jwt') {
                const jwtTextarea = document.getElementById('jwtToken');
                if (jwtTextarea) jwtTextarea.value = currentActualToken;
            }
        }

        // Only check for changes if not loading environment
        if (!isLoadingEnvironment) {
            checkForChanges();
            updateTitle();
        }
    }

    function updateAuthButtonVisibility(authMethod) {
        const signInBtn = document.getElementById('signInBtn');
        const signOutBtn = document.getElementById('signOutBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const requestTokenBtn = document.getElementById('requestTokenBtn');

        if (authMethod === 'none' || authMethod === 'jwt' || authMethod === 'google-service-account' || authMethod === 'dbmn') {
            // Hide OAuth buttons for non-OAuth auth methods
            hideElement(signInBtn);
            hideElement(signOutBtn);
            hideElement(refreshBtn);
            hideElement(requestTokenBtn);
        }
        // OAuth button visibility is handled by updateOAuthStatus
    }

    // Field Validation Functions
    function markFieldError(fieldId) {
        const field = document.getElementById(fieldId);
        if (field) {
            field.classList.add('field-error');
            field.setAttribute('aria-invalid', 'true');
        }
    }

    function clearFieldError(fieldId) {
        const field = document.getElementById(fieldId);
        if (field) {
            field.classList.remove('field-error');
            field.removeAttribute('aria-invalid');
        }
    }

    function validateOAuthFields() {
        let isValid = true;
        const authMethod = document.getElementById('authMethod').value;
        
        // Only validate if OAuth method is selected
        if (authMethod !== 'oauth') {
            return true;
        }
        
        // Define required fields for OAuth authentication
        const requiredFields = ['clientId', 'authorizationUrl', 'tokenUrl'];
        // Client secret is optional - let the OAuth provider decide

        // Clear all previous errors for OAuth fields
        ['clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl', 'scopes'].forEach(fieldId => clearFieldError(fieldId));

        // Check required fields are not empty
        requiredFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field && field.value.trim() === '') {
                markFieldError(fieldId);
                isValid = false;
            }
        });
        
        // Validate URL fields
        const urlFields = ['authorizationUrl', 'tokenUrl'];
        urlFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field && field.value.trim() !== '') {
                if (!isValidUrl(field.value.trim())) {
                    markFieldError(fieldId);
                    isValid = false;
                }
            }
        });
        
        // Validate Client ID format (basic check)
        const clientIdField = document.getElementById('clientId');
        if (clientIdField && clientIdField.value.trim() !== '') {
            const clientId = clientIdField.value.trim();
            if (clientId.length < 3 || clientId.includes(' ')) {
                markFieldError('clientId');
                isValid = false;
            }
        }
        
        // Validate scopes format (space-separated, no special chars)
        const scopesField = document.getElementById('scopes');
        if (scopesField && scopesField.value.trim() !== '') {
            const scopes = scopesField.value.trim();
            if (!isValidScopesFormat(scopes)) {
                markFieldError('scopes');
                isValid = false;
            }
        }

        return isValid;
    }

    // Validation helper functions
    function isValidUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.protocol === 'https:' || urlObj.protocol === 'http:';
        } catch {
            return false;
        }
    }
    
    function isValidScopesFormat(scopes) {
        // Check if scopes are space-separated and contain only valid characters
        const scopeArray = scopes.split(/\s+/).filter(s => s.length > 0);
        if (scopeArray.length === 0) return true; // Empty scopes are valid
        
        // Each scope should contain only alphanumeric, underscore, dash, colon, or dot
        const validScopePattern = /^[a-zA-Z0-9_\-:.]+$/;
        return scopeArray.every(scope => validScopePattern.test(scope));
    }
    
    function getFieldValidationMessage(fieldId, value) {
        switch (fieldId) {
            case 'authorizationUrl':
            case 'tokenUrl':
                if (!value || value.trim() === '') {
                    return `${fieldId === 'authorizationUrl' ? 'Authorization' : 'Token'} URL is required`;
                }
                if (!isValidUrl(value)) {
                    return 'Please enter a valid HTTPS or HTTP URL';
                }
                break;
            case 'clientId':
                if (!value || value.trim() === '') {
                    return 'Client ID is required';
                }
                if (value.length < 3) {
                    return 'Client ID must be at least 3 characters';
                }
                if (value.includes(' ')) {
                    return 'Client ID cannot contain spaces';
                }
                break;
            case 'clientSecret':
                if (!value || value.trim() === '') {
                    return 'Client Secret is required for this provider';
                }
                break;
            case 'scopes':
                if (value && !isValidScopesFormat(value)) {
                    return 'Scopes must be space-separated (e.g., "read write admin")';
                }
                break;
        }
        return '';
    }

    function scrollToFirstError() {
        const firstErrorField = document.querySelector('.field-error');
        if (firstErrorField) {
            // Switch to the tab containing the error before scrolling
            const tabPanel = firstErrorField.closest('.tab-panel');
            if (tabPanel) {
                const tabName = tabPanel.id.replace('tab-panel-', '');
                switchTab(tabName);
            }
            firstErrorField.scrollIntoView({ behavior: 'smooth', block: 'center' });
            firstErrorField.focus();
        }
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
            case 'tokenDecoded':
                handleTokenDecoded(message.token, message.decodedToken);
                break;
            case 'tokenError':
                handleTokenError(message.error);
                break;
            case 'tokenCleared':
                handleTokenCleared();
                break;
            case 'environmentLoaded':
                clearFooterNotification('elsewhere');
                handleEnvironmentLoaded(message.environment);
                break;
            case 'environmentChangedElsewhere':
                handleEnvironmentChangedElsewhere(message);
                break;
            case 'systemsList':
                renderEnvSystemDropdown(message.systems || [], message.selectedSystemId);
                break;
            case 'newEnvironmentDraft':
                applyNewEnvironmentDraft(message);
                break;
            case 'oauthDefaults':
                applyOAuthDefaults(message.defaults);
                break;
            case 'environmentSaved':
                handleEnvironmentSaved(message.environment);
                break;
            case 'environmentSaveError':
                handleEnvironmentSaveError(message.error);
                break;
            case 'environmentSetActive':
                handleEnvironmentSetActive(message.environmentId);
                break;
            case 'checkUnsavedChanges':
                handleCheckUnsavedChanges();
                break;
            case 'saveCurrentEnvironment':
                saveEnvironment();
                break;
            case 'environmentDeleted':
                handleEnvironmentDeleted(message.environmentId);
                break;
            case 'environmentDeleteError':
                handleEnvironmentDeleteError(message.error);
                break;
            case 'transactionCountResponse':
                confirmDeleteWithTransactionCount(message.count);
                break;
            case 'sectionContentLoaded':
                // Render documentation modal with section content
                if (window.renderDocumentationModal) {
                    window.renderDocumentationModal(
                        message.title,
                        message.html,
                        message.docPath,
                        message.section
                    );
                } else {
                    console.error('[Environment] renderDocumentationModal is not defined!');
                }
                break;
            case 'addPendingVariables':
                // GitHub Issue #165: Add pending ENV variables from endpoint flow
                // This is triggered when user confirms adding missing variables
                // Use timeout to ensure this runs AFTER resetChangeTracking completes
                handleAddPendingVariables(message.variables);
                break;
            case 'resetForNewEnvironment':
                // The panel was reused for another new environment and VS Code
                // skipped the reload, so this document never got a `load` event.
                // Clear the previous environment's state by hand.
                resetEnvironmentContext();
                resetChangeTracking();
                break;
        }
    });


    function loadEnvironmentData() {
        // Load environment details if editing existing environment
        vscode.postMessage({
            type: 'loadEnvironment',
            environmentId: currentEnvironmentId
        });
    }

    function saveEnvironment() {
        const name = document.getElementById('envName').value.trim();
        const environmentType = document.getElementById('envType').value;
        const baseUrl = document.getElementById('envBaseUrl').value.trim();
        const description = document.getElementById('envDescription').value.trim();
        const authMethod = document.getElementById('authMethod').value;
        const systemId = envSystemPicker ? (envSystemPicker.getSelected() || '') : '';

        // Clear any previous validation errors
        clearFieldError('envName');
        clearFieldError('envBaseUrl');
        clearFieldError('envSystemPicker');

        if (!name) {
            markFieldError('envName');
            vscode.postMessage({ type: 'validationError', message: 'Environment name is required' });
            scrollToFirstError();
            return;
        }

        if (!baseUrl) {
            markFieldError('envBaseUrl');
            vscode.postMessage({ type: 'validationError', message: 'Base URL is required' });
            scrollToFirstError();
            return;
        }

        // #424: a fixed URL's host stays; only its path changes (the host saves again checks too)
        if (envFixedBaseUrl && baseUrl !== envFixedBaseUrl && urlOrigin(baseUrl) !== urlOrigin(envFixedBaseUrl)) {
            markFieldError('envBaseUrl');
            vscode.postMessage({ type: 'validationError', message: `The host can't change: this environment is ${urlOrigin(envFixedBaseUrl)}. Change only the path, or make a new environment.` });
            scrollToFirstError();
            return;
        }

        if (!systemId) {
            markFieldError('envSystemPicker');
            vscode.postMessage({ type: 'validationError', message: 'Please pick a System (use "+ Add new System…" if none fits)' });
            scrollToFirstError();
            return;
        }

        // Parallel processing: one setting, how many at once (Sequential is 1). enabled stays in
        // the data, always true, so the engine and older versions read it as before.
        const maxConcurrency = parseInt(document.getElementById('maxConcurrency').value);

        // Get headers and variables from tables (Issue #126)
        const headers = getHeadersFromTable();
        const variables = getVariablesFromTable();
        const variableSettings = getVariableSettingsFromTable();

        // GitHub Issue #165: Warn if any variables have empty values (but don't block save)
        const emptyVariables = Object.entries(variables)
            .filter(([name, value]) => name && (!value || value.trim() === ''))
            .map(([name]) => name);

        if (emptyVariables.length > 0) {
            const varList = emptyVariables.join(', ');
            vscode.postMessage({
                type: 'showWarning',
                message: `Saved with empty variable(s): ${varList}`
            });
        }

        // GitHub Issue #162: Target timezone for datetime values
        const targetTimezone = document.getElementById('targetTimezone').value;

        const environmentData = {
            id: isNewEnvironment ? '' : currentEnvironmentId,
            name: name,
            environmentType: environmentType,
            baseUrl: baseUrl,
            description: description,
            authMethod: authMethod,
            folder: currentEnvironmentFolder,
            systemId: systemId,
            parallelProcessing: {
                enabled: true,
                maxConcurrency: maxConcurrency
            },
            headers: headers,
            variables: variables,
            variableSettings,
            targetTimezone: targetTimezone,
            runOn: document.getElementById('runOn')?.value || 'browser'
        };
        
        // Include auth configuration based on selected method
        if (authMethod === 'jwt') {
            environmentData.jwtToken = document.getElementById('jwtToken').value.trim();
        } else if (authMethod === 'oauth') {
            const oauthConfig = {
                provider: 'custom', // Generic provider since we simplified the selection
                clientId: document.getElementById('clientId').value.trim(),
                clientSecret: document.getElementById('clientSecret').value.trim(),
                authorizationUrl: document.getElementById('authorizationUrl').value.trim(),
                tokenUrl: document.getElementById('tokenUrl').value.trim(),
                flowType: document.getElementById('oauthFlow').value,
                // #415: how the client authenticates at the token endpoint is the environment's own setting
                clientAuth: document.getElementById('clientAuth').value,
                scopes: document.getElementById('scopes').value.split(' ').filter(s => s.trim()),
                usePKCE: document.getElementById('oauthFlow').value.includes('pkce')
            };

            environmentData.oauthConfig = oauthConfig;
        } else if (authMethod === 'google-service-account') {
            // Google Service Account config (Issue #126 Phase 2)
            const serviceAccountConfig = getServiceAccountConfig();
            const serviceAccountScopes = getServiceAccountScopes();

            if (serviceAccountConfig) {
                environmentData.googleServiceAccountConfig = serviceAccountConfig;
                environmentData.googleServiceAccountScopes = serviceAccountScopes;
            }
        }

        vscode.postMessage({
            type: 'saveEnvironment',
            environment: environmentData
        });
    }

    function setAsActive() {
        if (currentEnvironmentId) {
            vscode.postMessage({
                type: 'setActiveEnvironment',
                environmentId: currentEnvironmentId
            });
        }
    }

    function deleteEnvironment() {
        if (!currentEnvironmentId) {
            vscode.postMessage({ type: 'showWarning', message: 'Cannot delete - no environment loaded' });
            return;
        }

        // Request transaction count before showing confirmation
        vscode.postMessage({
            type: 'checkEnvironmentTransactions',
            environmentId: currentEnvironmentId
        });
    }

    function confirmDeleteWithTransactionCount(transactionCount) {
        const envName = document.getElementById('envName').value.trim();

        // Send confirmation request to backend (VS Code will show native dialog)
        vscode.postMessage({
            type: 'confirmDeleteEnvironment',
            environmentId: currentEnvironmentId,
            environmentName: envName,
            transactionCount: transactionCount
        });
    }

    function submitToken(token) {
        if (!token || !token.trim()) {
            vscode.postMessage({ type: 'validationError', message: 'Please provide a valid JWT token' });
            return;
        }
        vscode.postMessage({ type: 'submitToken', token: token.trim() });
    }

    function clearToken() {
        vscode.postMessage({ type: 'clearToken' });
    }

    /**
     * Decode a JWT token client-side (no backend round-trip needed).
     * Shows the token details section immediately when user pastes/types a token.
     * Token is only persisted when the user clicks Save Environment.
     */
    function decodeJwtClientSide(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3 || !parts.every(p => p.length > 0)) {
                clearTokenDetails();
                showFooterNotification('warning', 'Not a valid JWT format (expected header.payload.signature)');
                return;
            }

            // Base64url decode the payload
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(
                atob(base64).split('').map(c =>
                    '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                ).join('')
            );
            const decoded = JSON.parse(jsonPayload);

            // Show the shared token details section
            showTokenDetails(token, decoded);
        } catch (e) {
            clearTokenDetails();
            showFooterNotification('warning', 'Could not decode JWT payload');
        }
    }

    function handleTokenDecoded(rawToken, decodedTokenData) {
        // Use shared token details display
        showTokenDetails(rawToken, decodedTokenData);
    }

    function handleTokenError(error) {
        // Don't clear the section if we already have a client-side decoded token
        // (backend may fail for unsaved environments, but the decode is still valid)
        if (!decodedToken) {
            clearTokenDetails();
        }
        // Only show error if it's not the "no environment context" error during paste
        if (!error.includes('No environment context')) {
            showFooterNotification('error', 'Token error: ' + error);
        }
    }

    function handleTokenCleared() {
        currentActualToken = null;
        decodedToken = null;
        clearTokenDetails();
        clearFooterNotification();
    }

    function toggleRawJson() {
        const content = document.getElementById('rawJsonContent');
        const arrow = document.getElementById('rawJsonArrow');
        if (!content) return;

        const isHidden = content.classList.contains('hidden');
        content.classList.toggle('hidden');
        if (arrow) {
            arrow.innerHTML = isHidden ? '&#9660;' : '&#9654;';
        }
    }

    /**
     * Clear the shared token details section and reset all state
     */
    function clearTokenDetails() {
        const section = document.getElementById('tokenDetails');
        if (section) section.classList.add('hidden');

        const pill = document.getElementById('tokenStatusPill');
        if (pill) pill.classList.add('hidden');

        const toggle = document.getElementById('tokenViewToggle');
        if (toggle) toggle.classList.add('hidden');

        const claimsGrid = document.getElementById('tokenClaimsGrid');
        if (claimsGrid) claimsGrid.innerHTML = '';

        const rawJsonPre = document.getElementById('rawJsonPre');
        if (rawJsonPre) rawJsonPre.textContent = '';

        const rawJsonContent = document.getElementById('rawJsonContent');
        if (rawJsonContent) rawJsonContent.classList.add('hidden');

        const arrow = document.getElementById('rawJsonArrow');
        if (arrow) arrow.innerHTML = '&#9654;';

        const encodedText = document.getElementById('tokenEncodedText');
        if (encodedText) encodedText.textContent = '';

        // Reset view to decoded
        currentTokenView = 'decoded';
        const decodedView = document.getElementById('tokenDecodedView');
        if (decodedView) decodedView.classList.remove('hidden');
        const encodedView = document.getElementById('tokenEncodedView');
        if (encodedView) encodedView.classList.add('hidden');
    }

    /**
     * Try to decode a token as JWT. Returns the payload object or null.
     */
    function tryDecodeJwt(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3 || !parts.every(p => p.length > 0)) {
                return null;
            }
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(
                atob(base64).split('').map(c =>
                    '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                ).join('')
            );
            return JSON.parse(jsonPayload);
        } catch {
            return null;
        }
    }

    /**
     * Show the shared token details section.
     * Called by ALL auth flows (JWT, OAuth, Google SA).
     * @param {string} token - The raw token string
     * @param {object|null} decoded - Pre-decoded JWT payload, or null to attempt decode
     */
    function showTokenDetails(token, decoded) {
        if (!token || !token.trim()) return;

        // Store for copying
        currentActualToken = token;

        // Try to decode if not provided
        if (!decoded) {
            decoded = tryDecodeJwt(token);
        }

        const isJwt = !!decoded;
        decodedToken = decoded;

        const section = document.getElementById('tokenDetails');
        const pill = document.getElementById('tokenStatusPill');
        const toggle = document.getElementById('tokenViewToggle');
        const claimsGrid = document.getElementById('tokenClaimsGrid');
        const rawJsonPre = document.getElementById('rawJsonPre');
        const encodedText = document.getElementById('tokenEncodedText');

        if (!section) return;

        // Always populate encoded view
        if (encodedText) {
            encodedText.textContent = token;
        }

        if (isJwt) {
            // JWT: show status pill, toggle, and decoded view
            const now = Math.floor(Date.now() / 1000);
            const isExpired = decoded.exp ? decoded.exp < now : false;

            if (pill) {
                pill.textContent = isExpired ? 'Expired' : 'Valid';
                pill.className = 'status-pill-generic ' + (isExpired ? 'error' : 'success');
                pill.classList.remove('hidden');
            }

            if (toggle) {
                toggle.classList.remove('hidden');
            }

            // Build claims
            if (claimsGrid) {
                let html = '';
                const addClaim = (label, value) => {
                    if (value !== undefined && value !== null) {
                        html += `<span class="kv-label">${label}</span><span class="kv-value">${escapeHtml(String(value))}</span>`;
                    }
                };

                if (decoded.exp) {
                    addClaim('Expires', new Date(decoded.exp * 1000).toLocaleString());
                }
                if (decoded.iat) {
                    addClaim('Issued', new Date(decoded.iat * 1000).toLocaleString());
                }
                if (decoded.iss) {
                    addClaim('Issuer', decoded.iss);
                }
                if (decoded.sub) {
                    addClaim('Subject', decoded.sub);
                }

                claimsGrid.innerHTML = html;
            }

            if (rawJsonPre) {
                rawJsonPre.textContent = JSON.stringify(decoded, null, 2);
            }

            // Default to decoded view for JWTs
            switchTokenView('decoded');

            // (No valid/expired toast — the token pill + decoded claims already
            // show this inline. Avoids double-notification, and stops duplicate
            // toasts when the token section re-renders.)
        } else {
            // Non-JWT: hide pill and toggle, show encoded only
            if (pill) pill.classList.add('hidden');
            if (toggle) toggle.classList.add('hidden');
            if (claimsGrid) claimsGrid.innerHTML = '';
            if (rawJsonPre) rawJsonPre.textContent = '';

            // Force encoded view
            switchTokenView('encoded');
            // (Removed redundant 'Access token active' toast — the token section
            // appearing already conveys this; routine status isn't toast-worthy.)
        }

        // Show the section
        section.classList.remove('hidden');
    }

    /**
     * Switch between decoded and encoded token views
     */
    function switchTokenView(view) {
        currentTokenView = view;
        const decodedView = document.getElementById('tokenDecodedView');
        const encodedView = document.getElementById('tokenEncodedView');

        if (view === 'decoded') {
            if (decodedView) decodedView.classList.remove('hidden');
            if (encodedView) encodedView.classList.add('hidden');
        } else {
            if (decodedView) decodedView.classList.add('hidden');
            if (encodedView) encodedView.classList.remove('hidden');
        }

        // Update toggle button active state
        document.querySelectorAll('#tokenViewToggle .toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
    }

    /**
     * Copy content based on the active view (encoded token or formatted JSON)
     */
    function copyTokenView() {
        let textToCopy = '';

        if (currentTokenView === 'encoded' || !decodedToken) {
            // Copy raw token
            textToCopy = currentActualToken || '';
        } else {
            // Copy formatted JSON
            textToCopy = JSON.stringify(decodedToken, null, 2);
        }

        if (textToCopy) {
            // DBMN-native feedback, in the webview the user is looking at.
            window.DbmnClipboard.writeText(textToCopy).then(ok => {
                showFooterNotification(ok ? 'success' : 'error',
                    ok ? 'Copied to clipboard' : 'Failed to copy to clipboard');
            });
        } else {
            showFooterNotification('warning', 'No token available to copy');
        }
    }

    /**
     * Lazily-created SystemPicker instance bound to #envSystemPicker.
     * Held at module scope so repeated systemsList broadcasts reuse the
     * same instance (preserving its open/close state and outside-click
     * binding).
     *
     * For environments the picker starts with no selection — `saveEnvironment`
     * refuses to submit until the user picks something. That's the deliberate
     * P0.2 decision: don't silently default a new env to a random System.
     */
    let envSystemPicker = null;

    function renderEnvSystemDropdown(systems, selectedSystemId) {
        const container = document.getElementById('envSystemPicker');
        if (!container || !window.SystemPicker) return;

        if (!envSystemPicker) {
            envSystemPicker = window.SystemPicker.render(container, {
                placeholder: '-- Select System --',
                onSelect: () => {
                    // Mark the form dirty so Save enables when the user
                    // changes the System assignment — mirrors how every
                    // other form field is tracked in this editor.
                    if (typeof checkForChanges === 'function') checkForChanges();
                    if (typeof updateTitle === 'function') updateTitle();
                },
                onAddRequested: () => {
                    vscode.postMessage({ type: 'createSystem' });
                }
            });
        }
        envSystems = systems;
        envSystemPicker.setSystems(systems, selectedSystemId);
        envSystemPicker.setLocked(envSystemLocked);
        refreshDetailsHeading();
    }

    /**
     * #415: the URL (and a name from it) the New environment dialog asked for, filled in as if
     * typed, so the same checks run (sign-in URL suggestions) and Save is enabled.
     */
    function applyNewEnvironmentDraft(draft) {
        const fill = (id, value) => {
            const field = document.getElementById(id);
            if (!field || !value || field.value) return;
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        fill('envBaseUrl', draft.baseUrl);
        fill('envName', draft.name);
        // #415: the Standard System's default for how OAuth clients authenticate
        if (draft.clientAuth) {
            const clientAuth = document.getElementById('clientAuth');
            if (clientAuth) clientAuth.value = draft.clientAuth;
        }
        // The dialog chose the System and the URL, so they're fixed from here, as after a save:
        // a different one is a new environment. Next comes what the dialog didn't ask.
        setBaseUrlLocked(true);
        setSystemLocked(true);
        document.getElementById(draft.name ? 'envDescription' : 'envName')?.focus();
    }

    function handleEnvironmentLoaded(environment) {
        // Set loading flag to prevent change detection during form population
        isLoadingEnvironment = true;
        hadOAuthConfig = !!(environment.oauthConfig && (environment.oauthConfig.clientId || environment.oauthConfig.tokenUrl || environment.oauthConfig.clientAuth));

        // Pre-populate form with environment data
        document.getElementById('envName').value = environment.name || '';
        document.getElementById('envType').value = environment.environmentType || 'development';
        document.getElementById('envBaseUrl').value = environment.baseUrl || '';
        document.getElementById('envDescription').value = environment.description || '';

        // Set the System picker to the environment's assigned System if the
        // picker has already been populated by an earlier systemsList message.
        if (envSystemPicker && environment.systemId) {
            envSystemPicker.setSelected(environment.systemId);
        }

        // GitHub Issue #160: Lock baseUrl for existing environments - URL is immutable
        setBaseUrlLocked(true);
        setSystemLocked(!!environment.systemId);


        // Store folder internally (not shown in UI but needed for saving)
        currentEnvironmentFolder = environment.folder || '';

        // Parallel processing: what it runs today. Not enabled (or no setting) runs one at a time.
        const parallel = environment.parallelProcessing;
        document.getElementById('maxConcurrency').value = parallel?.enabled ? String(parallel.maxConcurrency || 1) : '1';

        // Load headers and variables (Issue #126)
        populateHeadersTable(environment.headers);
        populateVariablesTable(environment.variables, environment.variableSettings);

        // GitHub Issue #162: Load target timezone
        document.getElementById('targetTimezone').value = environment.targetTimezone || 'UTC';
        const runOn = document.getElementById('runOn');
        if (runOn) runOn.value = environment.runOn || 'browser';
        applyRunOnNote();

        // Set auth method and configure appropriate UI
        const authMethod = environment.authMethod || 'jwt'; // Default to JWT for backward compatibility
        document.getElementById('authMethod').value = authMethod;
        
        if (authMethod === 'jwt') {
            // Load JWT token if available
            const jwtToken = environment.jwtToken || '';
            document.getElementById('jwtToken').value = jwtToken;
            // Decode and show card immediately (programmatic .value set doesn't fire input event)
            if (jwtToken) {
                decodeJwtClientSide(jwtToken);
            }
        } else if (authMethod === 'oauth') {
            // Load OAuth configuration if available
            if (environment.oauthConfig) {
                // Environment has OAuth config, populating fields
                populateOAuthConfiguration(environment.oauthConfig);
            } else {
                // No OAuth config in environment, loading separately
                loadOAuthConfiguration();
            }
        } else if (authMethod === 'google-service-account') {
            // Load Google Service Account configuration (Issue #126 Phase 2)
            if (environment.googleServiceAccountConfig) {
                populateServiceAccountConfig(
                    environment.googleServiceAccountConfig,
                    environment.googleServiceAccountScopes
                );
            }
        } else if (authMethod === 'dbmn') {
            // DBMN auth — no special fields to load, token injected at execution time
        }

        // Update UI based on auth method
        handleAuthMethodChange();
        
        // Update UI for existing environment
        const activateBtn = document.getElementById('activateBtn');
        const deleteBtn = document.getElementById('deleteEnvBtn');

        if (activateBtn && !environment.isActive) {
            showElement(activateBtn);
        }

        // Always show Delete button for existing environments
        if (deleteBtn) {
            showElement(deleteBtn);
        }
        
        currentEnvironmentId = environment.id;
        isNewEnvironment = false;
        
        // Initialize OAuth interface
        initializeOAuthInterface();
        
        // Check OAuth status for OAuth environments
        if (authMethod === 'oauth' && currentEnvironmentId && !isNewEnvironment) {
            vscode.postMessage({
                type: 'checkOAuthStatus',
                environmentId: currentEnvironmentId
            });
        }
        
        // Reset change tracking after all environment data is loaded
        // Use requestAnimationFrame to ensure all DOM updates are complete
        requestAnimationFrame(() => {
            setTimeout(() => {
                isLoadingEnvironment = false; // Clear loading flag
                resetChangeTracking();
            }, 50);
        });
    }

    function handleEnvironmentSaved(environment) {
        // Update form state after successful save
        currentEnvironmentId = environment.id;
        currentEnvironmentFolder = environment.folder || '';
        isNewEnvironment = false;

        // GitHub Issue #160: Lock baseUrl after save - URL is now immutable
        setBaseUrlLocked(true);
        setSystemLocked(!!environment.systemId);


        const activateBtn = document.getElementById('activateBtn');
        const deleteBtn = document.getElementById('deleteEnvBtn');

        if (activateBtn && !environment.isActive) {
            showElement(activateBtn);
        }

        // Show Delete button now that environment is saved
        if (deleteBtn) {
            showElement(deleteBtn);
        }
        
        // If OAuth environment was just saved, check status (this will handle button visibility)
        const authMethod = document.getElementById('authMethod').value;
        if (authMethod === 'oauth') {
            vscode.postMessage({
                type: 'checkOAuthStatus',
                environmentId: currentEnvironmentId
            });
        }
        
        // The asterisk in the title disappears and the Save button idles; a short toast says
        // so as well, and a "could not save" from the attempt before goes with it. Without
        // that, a save that failed on its name and then went through on the next try still
        // showed the old error, and read as "not allowing me to save" (James, 2026-10-30).
        resetChangeTracking();
        clearFooterNotification('save');
        showFooterNotification('success', 'Environment saved', { source: 'save', duration: 4000 });
    }

    /**
     * The environment changed under this form (the Hub's header picked an org, another tab or
     * device saved it). No edits here: the form takes the change and says what moved. Edits here:
     * they stay, the change is named, and Save asks before anything is written over it.
     */
    function handleEnvironmentChangedElsewhere(message) {
        const what = (message.changes || []).join(', ') || 'settings changed';
        if (!hasUnsavedChanges) {
            handleEnvironmentLoaded(message.environment);
            vscode.postMessage({ type: 'environmentChangeApplied', environment: message.stored });
            showFooterNotification('info', 'Updated: ' + what, { source: 'elsewhere', duration: 6000 });
            return;
        }
        showFooterNotification('warning', 'Changed elsewhere: ' + what + '. Save will ask before writing over it.', { source: 'elsewhere', persistent: true });
    }

    function handleEnvironmentSaveError(error) {
        // Footer notification stays in-context with the form, unlike the
        // VS Code toast which interrupted the user's flow.
        clearFooterNotification('save');
        showFooterNotification('error', 'Could not save environment: ' + error, { shake: true, source: 'save' });
    }

    function handleEnvironmentSetActive(environmentId) {
        if (environmentId === currentEnvironmentId) {
            // Hide the "Set as Active" button since this environment is now active
            const activateBtn = document.getElementById('activateBtn');
            if (activateBtn) {
                hideElement(activateBtn);
            }
            // (Removed 'Environment set as active' toast — switching the active
            // environment can't fail and the UI already reflects it. Not toast-worthy.)
        }
    }

    function handleCheckUnsavedChanges() {
        // Check for unsaved changes and respond to extension
        checkForChanges();
        vscode.postMessage({
            type: 'unsavedChangesResponse',
            hasUnsavedChanges: hasUnsavedChanges
        });
    }


    function handleEnvironmentDeleted(environmentId) {
        if (environmentId === currentEnvironmentId) {
            // The webview will be closed by the backend, but show success message first
            vscode.postMessage({ type: 'showSuccess', message: 'Environment deleted successfully!' });
        }
    }

    function handleEnvironmentDeleteError(error) {
        vscode.postMessage({ type: 'showError', message: 'Error deleting environment: ' + error });
    }

    /**
     * GitHub Issue #165: Handle pending ENV variables from endpoint flow
     * This is called when user confirms adding missing ENV variables from the endpoint webview.
     * Variables are added dynamically AFTER the initial form state is captured,
     * which properly triggers hasUnsavedChanges.
     */
    function handleAddPendingVariables(variables) {
        if (!variables || !Array.isArray(variables) || variables.length === 0) {
            return;
        }

        // Wait for the environment to fully load and change tracking to reset
        // The environmentLoaded handler uses requestAnimationFrame + setTimeout(50ms)
        // so we need to wait longer than that
        setTimeout(() => {
            // Get existing variables to avoid duplicates
            const existingVars = getVariablesFromTable();

            // Add each new variable that doesn't already exist
            let addedCount = 0;
            let emptyValueVars = [];
            for (const varName of variables) {
                if (!(varName in existingVars)) {
                    addVariableRow(varName, '');
                    addedCount++;
                } else if (!existingVars[varName] || existingVars[varName].trim() === '') {
                    // Variable exists but has empty value - track it
                    emptyValueVars.push(varName);
                }
            }

            // If we added new vars OR there are existing vars with empty values,
            // mark as unsaved so user can fill in and save
            if (addedCount > 0 || emptyValueVars.length > 0) {
                // Force mark as unsaved if there are empty values to fill
                if (emptyValueVars.length > 0 && !hasUnsavedChanges) {
                    hasUnsavedChanges = true;
                    updateButtonStates();
                    updateTitle();
                }

                // Switch to Configuration tab and scroll to variables section
                switchTab('configuration');
                const variablesSection = document.getElementById('variablesTableBody');
                if (variablesSection) {
                    variablesSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                // Focus the first empty value field
                const rows = document.querySelectorAll('#variablesTableBody tr');
                for (const row of rows) {
                    const valueInput = row.querySelector('.variable-value');
                    if (valueInput && !valueInput.value) {
                        valueInput.focus();
                        break;
                    }
                }
            }
        }, 150); // Wait longer than the 50ms in handleEnvironmentLoaded
    }

    // OAuth Functions
    function initializeOAuthInterface() {
        // Only initialize OAuth interface if OAuth auth method is selected
        const authMethod = document.getElementById('authMethod').value;
        if (authMethod !== 'oauth') {
            return; // Don't show OAuth UI for non-OAuth auth methods
        }

        const oauthConfig = document.getElementById('oauthConfig');
        if (oauthConfig) oauthConfig.classList.remove('hidden');

        loadOAuthConfiguration();
        checkForChanges();
    }

    
    function autoDetectOAuthUrls() {
        const baseUrl = document.getElementById('envBaseUrl').value.trim();
        const authUrlField = document.getElementById('authorizationUrl');
        const tokenUrlField = document.getElementById('tokenUrl');
        const scopesField = document.getElementById('scopes');
        const authIndicator = document.getElementById('authUrlIndicator');
        const tokenIndicator = document.getElementById('tokenUrlIndicator');
        
        if (!baseUrl) {
            // Clear indicators if no base URL
            authIndicator.textContent = '';
            tokenIndicator.textContent = '';
            return;
        }
        
        if (baseUrl.includes('api.github.com')) {
            // GitHub has special OAuth URLs
            authUrlField.value = 'https://github.com/login/oauth/authorize';
            tokenUrlField.value = 'https://github.com/login/oauth/access_token';
            scopesField.value = 'user:email read:user';
            authIndicator.textContent = '(auto-detected)';
            tokenIndicator.textContent = '(auto-detected)';
            return;
        }
        // #415: the environment's Standard System may say where to sign in at this address; the
        // backend answers with oauthDefaults (applyOAuthDefaults). Nothing here knows any System.
        const systemId = (typeof envSystemPicker !== 'undefined' && envSystemPicker) ? (envSystemPicker.getSelected() || '') : '';
        if (!systemId) {
            applyOAuthDefaults(undefined);
            return;
        }
        vscode.postMessage({ type: 'resolveOAuthDefaults', baseUrl, systemId });
    }

    /**
     * #415: what the Standard System says about signing in at the current address, or nothing.
     * Its URLs and scopes are suggestions badged with the System's name, kept until the user
     * types their own; the flow and client authentication are set for a new environment only
     * (a saved one shows what it has). Without a System, the #361 suggestions from the base URL.
     */
    function applyOAuthDefaults(defaults) {
        const baseUrl = document.getElementById('envBaseUrl').value.trim();
        const authUrlField = document.getElementById('authorizationUrl');
        const tokenUrlField = document.getElementById('tokenUrl');
        const scopesField = document.getElementById('scopes');
        const authIndicator = document.getElementById('authUrlIndicator');
        const tokenIndicator = document.getElementById('tokenUrlIndicator');
        if (!defaults) {
            if (!baseUrl) return;
            // #361: suggest ABSOLUTE URLs from the whole base URL. '/oauth/authorize' alone
            // resolves against the host and lost a base path such as /functions/v1/sign-in.
            const root = baseUrl.replace(/\/+$/, '');
            suggestOAuthUrl(authUrlField, authIndicator, `${root}/oauth/authorize`, '/oauth/authorize');
            suggestOAuthUrl(tokenUrlField, tokenIndicator, `${root}/oauth/token`, '/oauth/token');
            return;
        }
        const label = `(from ${defaults.systemName})`;
        if (defaults.authorizationUrl) suggestOAuthUrl(authUrlField, authIndicator, defaults.authorizationUrl, '/oauth/authorize', label);
        if (defaults.tokenUrl) suggestOAuthUrl(tokenUrlField, tokenIndicator, defaults.tokenUrl, '/oauth/token', label);
        if (defaults.scopes && (!scopesField.value || scopesField.value === scopesField.dataset.suggested)) {
            scopesField.value = defaults.scopes.join(' ');
            scopesField.dataset.suggested = scopesField.value;
        }
        // The flow and the client authentication: the System's, unless this environment already
        // had OAuth settings of its own (then the stored or resolved value stands). An existing
        // environment switched to OAuth here starts from the System's, as a new one does: one on a Standard System
        // environment must not keep the page's "body" when the System says Basic.
        if (isNewEnvironment || !hadOAuthConfig) {
            if (defaults.flowType) document.getElementById('oauthFlow').value = defaults.flowType;
            if (defaults.clientAuth) document.getElementById('clientAuth').value = defaults.clientAuth;
        }
        checkForChanges();
    }

    /**
     * #361: fill a suggestion only where the user hasn't typed their own: an empty field, the
     * previous suggestion (it follows a changed base URL), or the old relative suggestion. Its
     * badge says "(suggested)" until the user types; then the value is theirs and the badge goes.
     */
    function suggestOAuthUrl(field, indicator, value, legacyRelative, label = '(suggested)') {
        const untouched = !field.value || field.value === field.dataset.suggested || field.value === legacyRelative;
        if (untouched) {
            field.value = value;
            field.dataset.suggested = value;
            indicator.textContent = label;
        } else if (field.value === field.dataset.suggested) {
            indicator.textContent = label;
        } else if (field.value !== field.dataset.suggested) {
            indicator.textContent = '';
        }
        if (!field.dataset.suggestionBound) {
            field.dataset.suggestionBound = 'true';
            field.addEventListener('input', () => {
                if (field.value !== field.dataset.suggested) {
                    indicator.textContent = '';
                    delete field.dataset.suggested;
                }
            });
        }
    }

    function autoConfigureOAuth() {
        // This function is now replaced by autoDetectOAuthUrls
        autoDetectOAuthUrls();
        vscode.postMessage({ 
            type: 'showInfo', 
            message: 'OAuth configuration auto-populated based on base URL' 
        });
    }


    function testOAuthConnection() {
        // Legacy function - redirect to unified Sign In flow
        initiateOAuthFlow();
    }

    function initiateOAuthFlow() {
        vscode.postMessage({
            type: 'oauthSignIn',
            environmentId: currentEnvironmentId
        });
    }

    function signOutOAuth() {
        vscode.postMessage({
            type: 'oauthSignOut',
            environmentId: currentEnvironmentId
        });
    }

    function refreshOAuthToken() {
        vscode.postMessage({
            type: 'oauthRefresh',
            environmentId: currentEnvironmentId
        });
    }

    function requestNewToken() {
        vscode.postMessage({
            type: 'oauthRequestNewToken',
            environmentId: currentEnvironmentId
        });
    }

    function loadOAuthConfiguration() {
        // Loading OAuth configuration
        vscode.postMessage({
            type: 'loadOAuthConfig',
            environmentId: currentEnvironmentId
        });
    }

    function updateOAuthStatus(status) {
        const signInBtn = document.getElementById('signInBtn');
        const signOutBtn = document.getElementById('signOutBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const requestTokenBtn = document.getElementById('requestTokenBtn');

        if (!status) return;

        // No notification here: this runs whenever the editor opens or checks, and opening an
        // environment is no time to say "Not Signed In". A run asks to sign in when it needs to;
        // a sign-in says how it went. The buttons below show the state.

        // "Sign In (New Token)" is always visible for OAuth environments
        showElement(requestTokenBtn);

        // Show/hide other auth buttons based on authentication status
        if (status.authenticated) {
            hideElement(signInBtn);
            showElement(signOutBtn);

            if (status.hasRefreshCapability) {
                showElement(refreshBtn);
            } else {
                hideElement(refreshBtn);
            }
        } else {
            showElement(signInBtn);
            hideElement(signOutBtn);
            hideElement(refreshBtn);
        }
    }

    function populateOAuthConfiguration(config) {
        // Populating OAuth configuration form
        
        if (!config) {
            // No OAuth config provided
            return;
        }
        
        // No longer need to set provider since we simplified to just auth method
        document.getElementById('clientId').value = config.clientId || '';
        document.getElementById('clientSecret').value = config.clientSecret || '';
        document.getElementById('authorizationUrl').value = config.authorizationUrl || '';
        document.getElementById('tokenUrl').value = config.tokenUrl || '';
        document.getElementById('oauthFlow').value = config.flowType || 'authorization_code';
        document.getElementById('clientAuth').value = config.clientAuth || 'body';
        document.getElementById('scopes').value = (config.scopes || []).join(' ');
        
        // OAuth config populated successfully
    }

    // Handle additional OAuth-specific messages
    window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
            case 'oauthConfigLoaded':
                // OAuth config loaded from backend
                populateOAuthConfiguration(message.config);
                break;
                
            case 'oauthStatusUpdate':
                updateOAuthStatus(message.status);
                break;
                
            case 'oauthTokenLoaded':
                // Handle OAuth tokens (different from JWT tokens)
                // OAuth token loaded and displayed
                handleOAuthTokenLoaded(message.token, message.baseUrl);
                break;

            case 'serviceAccountAuthResult':
                // Handle Google Service Account authentication test result (Issue #126 Phase 2)
                if (message.success) {
                    showServiceAccountStatus('success', message.message);
                } else {
                    showServiceAccountStatus('error', `❌ ${message.error}`);
                }
                break;
        }
    });

    // Client secret visibility toggle
    function toggleClientSecretVisibility() {
        const secretField = document.getElementById('clientSecret');
        const toggleBtn = document.getElementById('toggleSecretBtn');

        if (secretField.type === 'password') {
            secretField.type = 'text';
            toggleBtn.textContent = 'Hide';
            toggleBtn.title = 'Hide client secret';
        } else {
            secretField.type = 'password';
            toggleBtn.textContent = 'Show';
            toggleBtn.title = 'Show client secret';
        }
    }

    // Google Service Account functions (Issue #126 Phase 2)
    function uploadServiceAccountFile() {
        const fileInput = document.getElementById('serviceAccountFileInput');
        if (fileInput) {
            fileInput.click();
        }
    }

    function handleServiceAccountFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const jsonContent = e.target.result;
                const parsed = JSON.parse(jsonContent);

                // Validate it's a service account file
                if (parsed.type !== 'service_account') {
                    showServiceAccountStatus('error', 'Invalid file: Not a service account JSON file');
                    return;
                }

                // Display the JSON in the textarea
                document.getElementById('serviceAccountJson').value = JSON.stringify(parsed, null, 2);
                showServiceAccountStatus('success', `✅ Loaded service account: ${parsed.client_email}`);
                checkForChanges();
            } catch (err) {
                showServiceAccountStatus('error', `Invalid JSON: ${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    function clearServiceAccount() {
        document.getElementById('serviceAccountJson').value = '';
        hideServiceAccountStatus();
        checkForChanges();
    }

    function showServiceAccountStatus(type, message) {
        const statusEl = document.getElementById('serviceAccountStatus');
        if (!statusEl) return;

        statusEl.classList.remove('hidden');
        if (type === 'error') {
            statusEl.style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
            statusEl.style.border = '1px solid var(--vscode-inputValidation-errorBorder)';
        } else if (type === 'success') {
            statusEl.style.backgroundColor = 'var(--vscode-inputValidation-infoBackground)';
            statusEl.style.border = '1px solid var(--vscode-inputValidation-infoBorder)';
        }
        statusEl.textContent = message;
    }

    function hideServiceAccountStatus() {
        const statusEl = document.getElementById('serviceAccountStatus');
        if (statusEl) {
            statusEl.classList.add('hidden');
        }
    }

    function handleScopePresetChange() {
        const preset = document.getElementById('serviceAccountScopePreset').value;
        const customGroup = document.getElementById('customScopesGroup');
        const scopesTextarea = document.getElementById('serviceAccountScopes');

        if (preset === 'custom') {
            customGroup.classList.remove('hidden');
        } else {
            customGroup.classList.add('hidden');
            // Set the scope based on preset
            const scopeMap = {
                'cloud-platform': 'https://www.googleapis.com/auth/cloud-platform',
                'pubsub': 'https://www.googleapis.com/auth/pubsub',
                'storage': 'https://www.googleapis.com/auth/devstorage.read_write',
                'bigquery': 'https://www.googleapis.com/auth/bigquery'
            };
            scopesTextarea.value = scopeMap[preset] || '';
        }
        checkForChanges();
    }

    function testServiceAccountAuth() {
        const jsonTextarea = document.getElementById('serviceAccountJson');
        if (!jsonTextarea.value.trim()) {
            showServiceAccountStatus('error', 'Please upload or paste a service account JSON file first');
            return;
        }

        try {
            const config = JSON.parse(jsonTextarea.value);
            if (config.type !== 'service_account') {
                showServiceAccountStatus('error', 'Invalid: Not a service account JSON');
                return;
            }

            // Get scopes
            const preset = document.getElementById('serviceAccountScopePreset').value;
            let scopes;
            if (preset === 'custom') {
                scopes = document.getElementById('serviceAccountScopes').value
                    .split('\n')
                    .map(s => s.trim())
                    .filter(s => s);
            } else {
                const scopeMap = {
                    'cloud-platform': ['https://www.googleapis.com/auth/cloud-platform'],
                    'pubsub': ['https://www.googleapis.com/auth/pubsub'],
                    'storage': ['https://www.googleapis.com/auth/devstorage.read_write'],
                    'bigquery': ['https://www.googleapis.com/auth/bigquery']
                };
                scopes = scopeMap[preset] || ['https://www.googleapis.com/auth/cloud-platform'];
            }

            // Send test request to backend
            vscode.postMessage({
                type: 'testServiceAccountAuth',
                config: config,
                scopes: scopes
            });

            showServiceAccountStatus('success', '🔄 Testing authentication...');
        } catch (err) {
            showServiceAccountStatus('error', `Invalid JSON: ${err.message}`);
        }
    }

    function getServiceAccountConfig() {
        const jsonTextarea = document.getElementById('serviceAccountJson');
        if (!jsonTextarea || !jsonTextarea.value.trim()) {
            return null;
        }

        try {
            return JSON.parse(jsonTextarea.value);
        } catch {
            return null;
        }
    }

    function getServiceAccountScopes() {
        const preset = document.getElementById('serviceAccountScopePreset')?.value;
        if (preset === 'custom') {
            const scopesText = document.getElementById('serviceAccountScopes')?.value || '';
            return scopesText.split('\n').map(s => s.trim()).filter(s => s);
        }

        const scopeMap = {
            'cloud-platform': ['https://www.googleapis.com/auth/cloud-platform'],
            'pubsub': ['https://www.googleapis.com/auth/pubsub'],
            'storage': ['https://www.googleapis.com/auth/devstorage.read_write'],
            'bigquery': ['https://www.googleapis.com/auth/bigquery']
        };
        return scopeMap[preset] || ['https://www.googleapis.com/auth/cloud-platform'];
    }

    function populateServiceAccountConfig(config, scopes) {
        if (config) {
            document.getElementById('serviceAccountJson').value = JSON.stringify(config, null, 2);
            showServiceAccountStatus('success', `✅ Service account: ${config.client_email}`);
        }

        if (scopes && scopes.length > 0) {
            // Check if it matches a preset
            const scopeStr = scopes[0];
            const presetMap = {
                'https://www.googleapis.com/auth/cloud-platform': 'cloud-platform',
                'https://www.googleapis.com/auth/pubsub': 'pubsub',
                'https://www.googleapis.com/auth/devstorage.read_write': 'storage',
                'https://www.googleapis.com/auth/bigquery': 'bigquery'
            };

            const preset = presetMap[scopeStr];
            if (preset && scopes.length === 1) {
                document.getElementById('serviceAccountScopePreset').value = preset;
                document.getElementById('customScopesGroup').classList.add('hidden');
            } else {
                document.getElementById('serviceAccountScopePreset').value = 'custom';
                document.getElementById('customScopesGroup').classList.remove('hidden');
                document.getElementById('serviceAccountScopes').value = scopes.join('\n');
            }
        }
    }

    // Legacy alias — kept for any residual references
    function copyCurrentToken() {
        copyTokenView();
    }

    function handleOAuthTokenLoaded(token, baseUrl) {
        // Use shared token details — tries JWT decode automatically
        showTokenDetails(token, null);
    }

    // ==========================================
    // Footer Notification System
    // ==========================================

    /**
     * Show a notification in the footer bar
     * @param {string} type - 'error', 'warning', or 'info'
     * @param {string} message - The message to display
     * @param {object} options - { persistent: false, shake: false, source: a label clearFooterNotification(source) takes down }
     */
    // Delegates to the shared fixed-overlay DbmnToast (no content shift). Kept
    // as a wrapper so existing call sites are unchanged. `duration` → `durationMs`.
    function showFooterNotification(type, message, options = {}) {
        if (window.DbmnToast) {
            window.DbmnToast.show(type, message, {
                durationMs: options.duration,
                persistent: options.persistent,
                shake: options.shake,
                dismissible: options.dismissible,
                source: options.source
            });
            return;
        }
        // Fallback for the (now unlikely) case DbmnToast isn't loaded.
        vscode.postMessage({ type: type === 'error' ? 'showError' : type === 'warning' ? 'showWarning' : 'showInfo', message: message });
    }

    /** Takes down the toasts from one source (a save's outcome), or every one with no source given. */
    function clearFooterNotification(source) {
        if (window.DbmnToast) window.DbmnToast.clear(source);
    }

    // ==========================================
    // Headers Table Management (Issue #126)
    // ==========================================

    function addHeaderRow(name = '', value = '', enabled = true) {
        const tbody = document.getElementById('headersTableBody');
        const row = document.createElement('tr');

        row.innerHTML = `
            <td class="col-checkbox">
                <input type="checkbox" class="header-enabled" ${enabled ? 'checked' : ''} data-change="rowChanged" />
            </td>
            <td class="col-name">
                <input type="text" class="header-name" value="${escapeHtml(name)}" placeholder="Header-Name" data-change="rowChanged" data-input="rowChanged" />
            </td>
            <td class="col-value">
                <input type="text" class="header-value" value="${escapeHtml(value)}" placeholder="Header value or {{variable}}" data-change="rowChanged" data-input="rowChanged" />
            </td>
            <td class="col-actions">
                <button data-click="removeHeaderRow" class="btn-delete-row" title="Remove header">
                    <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5zm2 2h1v5H7V6zm2 0h1v5H9V6z"/></svg>
                </button>
            </td>
        `;

        tbody.appendChild(row);
        checkForChanges();
        updateTitle();
    }

    function removeHeaderRow(button) {
        const row = button.closest('tr');
        row.remove();
        checkForChanges();
        updateTitle();
    }

    function getHeadersFromTable() {
        const headers = {};
        const rows = document.querySelectorAll('#headersTableBody tr');

        rows.forEach(row => {
            const nameInput = row.querySelector('.header-name');
            const valueInput = row.querySelector('.header-value');
            const enabledInput = row.querySelector('.header-enabled');

            if (nameInput && valueInput && enabledInput) {
                const name = nameInput.value.trim();
                const value = valueInput.value;
                const enabled = enabledInput.checked;

                if (name) {
                    headers[name] = {
                        value: value,
                        enabled: enabled
                    };
                }
            }
        });

        return headers;
    }

    function populateHeadersTable(headers) {
        const tbody = document.getElementById('headersTableBody');
        tbody.innerHTML = '';

        if (headers && typeof headers === 'object') {
            Object.entries(headers).forEach(([name, config]) => {
                // Handle both new format {value, enabled} and legacy string format
                if (typeof config === 'object') {
                    addHeaderRow(name, config.value || '', config.enabled !== false);
                } else {
                    addHeaderRow(name, config, true);
                }
            });
        }
    }

    // ==========================================
    // Variables Table Management (Issue #126)
    // ==========================================

    // #424: a variable may have options, and a place in the header
    function addVariableRow(name = '', value = '', settings = {}) {
        const tbody = document.getElementById('variablesTableBody');
        const row = document.createElement('tr');
        // #424: an option with a label reads `840 = Brisbane` (variable-options.ts formatOptions)
        const labels = settings.labels || {};
        const options = Array.isArray(settings.options) ? settings.options.map(o => labels[o] ? `${o} = ${labels[o]}` : o).join(', ') : '';

        row.innerHTML = `
            <td class="col-name">
                <input type="text" class="variable-name" value="${escapeHtml(name)}" placeholder="variableName" data-change="rowChanged" data-input="rowChanged" />
            </td>
            <td class="col-value">
                <input type="text" class="variable-value" value="${escapeHtml(value)}" placeholder="Variable value" data-change="rowChanged" data-input="rowChanged" />
                <select class="variable-value-pick" hidden data-change="variableValuePicked" title="One of its Options"></select>
            </td>
            <td class="col-options">
                <input type="text" class="variable-options" value="${escapeHtml(options)}" placeholder="a, b, 840 = Brisbane (optional)" title="Comma-separated. The header offers these and a run checks the value is one of them. value = Label shows the label where you pick it; requests send the value." data-change="rowChanged" data-input="rowChanged" />
            </td>
            <td class="col-header">
                <input type="checkbox" class="variable-header" ${settings.showInHeader ? 'checked' : ''} title="Show in the Hub header, switchable there" data-change="rowChanged" />
            </td>
            <td class="col-actions">
                <button data-click="removeVariableRow" class="btn-delete-row" title="Remove variable">
                    <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5zm2 2h1v5H7V6zm2 0h1v5H9V6z"/></svg>
                </button>
            </td>
        `;

        tbody.appendChild(row);
        refreshVariableValue(row);
        checkForChanges();
        updateTitle();
    }

    /**
     * The options typed in a variable row's Options box, in order and unique, with their labels:
     * `840 = Brisbane` is the value 840 labelled Brisbane (the same rule as variable-options.ts
     * parseOptions).
     */
    function parseVariableOptions(row) {
        const options = [];
        const labels = {};
        (row.querySelector('.variable-options')?.value || '').split(/[,\n]/).forEach(part => {
            const at = part.indexOf('=');
            const value = (at < 0 ? part : part.slice(0, at)).trim();
            const label = at < 0 ? '' : part.slice(at + 1).trim();
            if (!value || options.includes(value)) return;
            options.push(value);
            if (label && label !== value) labels[value] = label;
        });
        return { options, labels };
    }


    /**
     * #424: a variable with Options takes its Value from them, as a dropdown, so it can't hold
     * anything else; a value not in the list shows "Pick one…" in the warning colour until one
     * is picked. The text input stays the value the form saves.
     */
    function refreshVariableValue(row) {
        const input = row.querySelector('.variable-value');
        const pick = row.querySelector('.variable-value-pick');
        if (!input || !pick) return;
        const { options, labels } = parseVariableOptions(row);
        const picked = options.includes(input.value);
        input.hidden = options.length > 0;
        pick.hidden = !options.length;
        row.classList.toggle('variable-value-unpicked', options.length > 0 && !picked);
        if (!options.length) return;
        pick.innerHTML = '';
        (picked ? options : ['', ...options]).forEach(value => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = !value ? 'Pick one…' : labels[value] ? `${labels[value]} · ${value}` : value;
            pick.appendChild(option);
        });
        pick.value = picked ? input.value : '';
    }

    function removeVariableRow(button) {
        const row = button.closest('tr');
        row.remove();
        checkForChanges();
        updateTitle();
    }

    function getVariablesFromTable() {
        const variables = {};
        const rows = document.querySelectorAll('#variablesTableBody tr');

        rows.forEach(row => {
            const nameInput = row.querySelector('.variable-name');
            const valueInput = row.querySelector('.variable-value');

            if (nameInput && valueInput) {
                const name = nameInput.value.trim();
                const value = valueInput.value;

                if (name) {
                    variables[name] = value;
                }
            }
        });

        return variables;
    }

    // #424: the options and the header flag per variable; a row with neither has no entry
    function getVariableSettingsFromTable() {
        const settings = {};
        document.querySelectorAll('#variablesTableBody tr').forEach(row => {
            const name = row.querySelector('.variable-name')?.value.trim();
            if (!name) return;
            const { options: typed, labels } = parseVariableOptions(row);
            const showInHeader = !!row.querySelector('.variable-header')?.checked;
            if (!typed.length && !showInHeader) return;
            const entry = {};
            if (typed.length) entry.options = typed;
            if (Object.keys(labels).length) entry.labels = labels;
            if (showInHeader) entry.showInHeader = true;
            settings[name] = entry;
        });
        return settings;
    }

    function populateVariablesTable(variables, variableSettings) {
        const tbody = document.getElementById('variablesTableBody');
        tbody.innerHTML = '';

        if (variables && typeof variables === 'object') {
            Object.entries(variables).forEach(([name, value]) => {
                addVariableRow(name, String(value), (variableSettings && variableSettings[name]) || {});
            });
        }
    }

    // Helper function to escape HTML
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Initialize OAuth interface on load
    window.addEventListener('load', () => {
        initializeOAuthInterface();
    });

    // Make functions globally available for onclick handlers
    window.switchTab = switchTab;
    window.saveEnvironment = saveEnvironment;
    window.setAsActive = setAsActive;
    window.deleteEnvironment = deleteEnvironment;
    window.clearToken = clearToken;
    window.toggleRawJson = toggleRawJson;
    window.autoConfigureOAuth = autoConfigureOAuth;
    window.testOAuthConnection = testOAuthConnection;
    window.initiateOAuthFlow = initiateOAuthFlow;
    window.signOutOAuth = signOutOAuth;
    window.refreshOAuthToken = refreshOAuthToken;
    window.requestNewToken = requestNewToken;
    window.copyCurrentToken = copyCurrentToken;
    window.copyTokenView = copyTokenView;
    window.switchTokenView = switchTokenView;
    window.toggleClientSecretVisibility = toggleClientSecretVisibility;
    window.addHeaderRow = addHeaderRow;
    window.removeHeaderRow = removeHeaderRow;
    window.addVariableRow = addVariableRow;
    window.removeVariableRow = removeVariableRow;
    window.checkForChanges = checkForChanges;
    window.updateTitle = updateTitle;
    window.clearFooterNotification = clearFooterNotification;
    // Google Service Account functions (Issue #126 Phase 2)
    window.uploadServiceAccountFile = uploadServiceAccountFile;
    window.handleServiceAccountFileSelect = handleServiceAccountFileSelect;
    window.clearServiceAccount = clearServiceAccount;
    window.handleScopePresetChange = handleScopePresetChange;
    window.testServiceAccountAuth = testServiceAccountAuth;

    // #372: what the markup may call (data-click / data-change); the web app's CSP refuses inline handlers
    window.DbmnActions.register({
        switchTab: tab => switchTab(tab),
        switchTokenView: view => switchTokenView(view),
        saveEnvironment: () => saveEnvironment(),
        setAsActive: () => setAsActive(),
        deleteEnvironment: () => deleteEnvironment(),
        toggleRawJson: () => toggleRawJson(),
        autoConfigureOAuth: () => autoConfigureOAuth(),
        initiateOAuthFlow: () => initiateOAuthFlow(),
        signOutOAuth: () => signOutOAuth(),
        refreshOAuthToken: () => refreshOAuthToken(),
        requestNewToken: () => requestNewToken(),
        copyTokenView: () => copyTokenView(),
        toggleClientSecretVisibility: () => toggleClientSecretVisibility(),
        addHeaderRow: () => addHeaderRow(),
        addVariableRow: () => addVariableRow(),
        editBaseUrlPath: () => editBaseUrlPath(),
        removeHeaderRow: (_arg, _event, element) => removeHeaderRow(element),
        removeVariableRow: (_arg, _event, element) => removeVariableRow(element),
        rowChanged: (_arg, _event, element) => {
            const variableRow = element?.closest?.('#variablesTableBody tr');
            if (variableRow) refreshVariableValue(variableRow);
            checkForChanges();
            updateTitle();
        },
        variableValuePicked: (_arg, _event, element) => {
            const row = element.closest('tr');
            row.querySelector('.variable-value').value = element.value;
            refreshVariableValue(row);
            checkForChanges();
            updateTitle();
        },
        clearFooterNotification: () => clearFooterNotification(),
        uploadServiceAccountFile: () => uploadServiceAccountFile(),
        serviceAccountFileSelected: (_arg, event) => handleServiceAccountFileSelect(event),
        clearServiceAccount: () => clearServiceAccount(),
        handleScopePresetChange: () => handleScopePresetChange(),
        testServiceAccountAuth: () => testServiceAccountAuth()
    });
})();

// `{{` in an environment header's value: this environment's own variables (as ENV:name, the same
// spelling an endpoint uses) and the generated ones (template-autocomplete.js)
(function () {
    if (!window.TemplateAutocomplete) return;
    window.TemplateAutocomplete.attach({
        selector: '#headersTableBody .header-value',
        suggestions: () => {
            const rows = Array.from(document.querySelectorAll('#variablesTableBody tr'));
            const env = rows.map(row => ({
                name: (row.querySelector('.variable-name')?.value || '').trim(),
                value: (row.querySelector('.variable-value')?.value || '').trim()
            })).filter(v => v.name).map(v => ({ value: 'ENV:' + v.name, detail: v.value, group: 'This environment' }));
            return env.concat(window.TemplateAutocomplete.GENERATED);
        },
        empty: { 'This environment': 'No variables yet: add them below' }
    });
}());
