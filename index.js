const EXTENSION_ID = 'st-stream-helper';
const LEGACY_HISTORY_KEY = `${EXTENSION_ID}:history:v1`;
const SETTINGS_KEY = `${EXTENSION_ID}:settings:v1`;
const DEFAULT_HISTORY_LIMIT = 6;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 1000;
const FALLBACK_COUNT_COLOR = '#4f6bed';
const TARGET_PATH = '/api/backends/chat-completions/generate';
const PATCH_KEY = Symbol.for(`${EXTENSION_ID}:fetch-patch`);

let historyLimit = loadHistoryLimit();
let countColor = loadCountColor();
let history = [];
let panelOpen = false;
// Requests, responses, and their metadata stay in memory for the current page only.
const sessionRaw = new Map();

function normalizeHistoryLimit(value, fallback = DEFAULT_HISTORY_LIMIT) {
    if (value === '' || value === null || value === undefined) return fallback;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return fallback;
    return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, Math.trunc(numericValue)));
}

function loadHistoryLimit() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        return normalizeHistoryLimit(settings?.historyLimit);
    } catch (error) {
        console.warn('[Tavern Stream Helper] Không thể đọc cài đặt tự động dọn dẹp.', error);
        return DEFAULT_HISTORY_LIMIT;
    }
}

function normalizeCountColor(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^#([\da-f]{6})$/i);
    return match ? `#${match[1].toLowerCase()}` : null;
}

function loadCountColor() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        return normalizeCountColor(settings?.countColor);
    } catch (error) {
        console.warn('[Tavern Stream Helper] Không thể đọc cài đặt màu vòng số.', error);
        return null;
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ historyLimit, countColor }));
    } catch (error) {
        console.warn('[Tavern Stream Helper] Không thể lưu cài đặt plugin.', error);
    }
}

function computedColorToHex(value) {
    const directHex = normalizeCountColor(value);
    if (directHex) return directHex;
    if (!value || !document.body || !globalThis.CSS?.supports?.('color', value)) return null;

    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = value;
    document.body.append(probe);
    const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    probe.remove();
    if (!channels || channels.length !== 3 || channels.some(channel => !Number.isFinite(channel))) return null;
    return `#${channels.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

function themeCountColorForPicker() {
    const themeColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--SmartThemeQuoteColor')
        .trim();
    return computedColorToHex(themeColor) || FALLBACK_COUNT_COLOR;
}

function applyCountColor(button = document.getElementById(`${EXTENSION_ID}-button`)) {
    if (!button) return;
    if (countColor) {
        button.style.setProperty('--stsh-count-color', countColor);
    } else {
        button.style.removeProperty('--stsh-count-color');
    }
}

function clearLegacyHistory() {
    try {
        localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch (error) {
        console.warn('[Tavern Stream Helper] Không thể dọn dẹp dữ liệu lưu trữ phiên bản cũ.', error);
    }
}

function pruneSessionRaw() {
    const retainedIds = new Set(history.map(item => item.localId));
    for (const localId of sessionRaw.keys()) {
        if (!retainedIds.has(localId)) sessionRaw.delete(localId);
    }
}

function applyRetentionLimit() {
    history = history.slice(0, historyLimit);
    pruneSessionRaw();
}

function isTargetRequest(input) {
    try {
        const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        return new URL(rawUrl, location.href).pathname.endsWith(TARGET_PATH);
    } catch {
        return false;
    }
}

function readRequestedModel(input, init) {
    // SillyTavern 1.18.0 normally passes a JSON string in init.body. This function
    // extracts only its routing field; the separate raw copy is session-memory-only.
    const body = init?.body;
    if (typeof body !== 'string') return null;

    try {
        const data = JSON.parse(body);
        return firstString(data.model, data.custom_model, data.model_id, data.modelId);
    } catch {
        return null;
    }
}

function readRawRequestBody(init) {
    const body = init?.body;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return null;
}

function rawEntry(record) {
    if (!sessionRaw.has(record.localId)) {
        sessionRaw.set(record.localId, { request: null, responseChunks: [] });
    }
    return sessionRaw.get(record.localId);
}

function appendRawResponse(record, text) {
    if (!text) return;
    rawEntry(record).responseChunks.push(text);
}

function getRawResponse(record) {
    return rawEntry(record).responseChunks.join('');
}

function firstString(...values) {
    const value = values.find(item => typeof item === 'string' && item.trim());
    return value ? value.trim() : null;
}

function newRecord(requestedModel) {
    return {
        localId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requestedModel,
        responseId: null,
        contentModelCounts: {},
        streamModelCounts: {},
        finalUsageModel: null,
        usageSource: null,
        systemFingerprint: null,
        responseHeaders: {},
        eventCount: 0,
        parseErrors: 0,
        httpStatus: null,
        responseContentType: null,
        detectedResponseFormat: null,
        sawDoneMarker: false,
        abortRequested: false,
        error: null,
        state: 'running',
    };
}

function incrementCounter(counter, key) {
    if (!key) return;
    counter[key] = (counter[key] || 0) + 1;
}

function modelFromPayload(payload) {
    return firstString(
        payload?.model,
        payload?.message?.model,
        payload?.response?.model,
        payload?.data?.model,
    );
}

function idFromPayload(payload) {
    return firstString(
        payload?.id,
        payload?.message?.id,
        payload?.response?.id,
        payload?.data?.id,
    );
}

function hasGeneratedText(payload) {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    if (choices.some(choice => {
        const delta = choice?.delta || {};
        const message = choice?.message || {};
        return [delta.content, delta.reasoning_content, delta.reasoning, message.content]
            .some(value => typeof value === 'string' && value.length > 0);
    })) return true;

    if (payload?.type === 'content_block_delta') {
        const delta = payload?.delta || {};
        return [delta.text, delta.thinking, delta.partial_json]
            .some(value => typeof value === 'string' && value.length > 0);
    }

    return false;
}

function usageFromPayload(payload) {
    return payload?.usage || payload?.message?.usage || payload?.response?.usage || null;
}

function inspectPayload(record, payload) {
    if (!payload || typeof payload !== 'object') return;

    record.eventCount += 1;
    const model = modelFromPayload(payload);
    const responseId = idFromPayload(payload);
    const usage = usageFromPayload(payload);

    if (responseId) record.responseId = responseId;
    if (model) incrementCounter(record.streamModelCounts, model);
    if (model && hasGeneratedText(payload)) incrementCounter(record.contentModelCounts, model);

    if (usage) {
        if (model) record.finalUsageModel = model;
        record.usageSource = firstString(
            usage.usage_source,
            usage.source,
            usage.billing_usage?.source,
            usage.billing?.source,
        ) || record.usageSource;
    }

    record.systemFingerprint = firstString(
        payload.system_fingerprint,
        payload.message?.system_fingerprint,
        payload.response?.system_fingerprint,
    ) || record.systemFingerprint;
}

function readAllowedHeaders(response) {
    const names = [
        'x-request-id',
        'request-id',
        'cf-ray',
        'x-model',
        'x-model-id',
        'x-upstream-model',
        'x-ratelimit-model',
    ];
    const headers = {};
    for (const name of names) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
    }
    return headers;
}

function parseSseBlock(record, block) {
    const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n')
        .trim();

    if (!data) return;
    if (data === '[DONE]') {
        record.sawDoneMarker = true;
        return;
    }

    try {
        inspectPayload(record, JSON.parse(data));
    } catch {
        record.parseErrors += 1;
    }
}

function drainSseBlocks(record, parserState, flush = false) {
    // Preserve a trailing CR until the next network chunk arrives, because CRLF can
    // itself be split across chunks. Convert lone CR characters only at final flush.
    parserState.buffer = parserState.buffer.replace(/\r\n/g, '\n');
    if (flush) parserState.buffer = parserState.buffer.replace(/\r/g, '\n');

    let boundary;
    while ((boundary = parserState.buffer.indexOf('\n\n')) !== -1) {
        const block = parserState.buffer.slice(0, boundary);
        parserState.buffer = parserState.buffer.slice(boundary + 2);
        if (block.split('\n').some(line => line.startsWith('data:'))) {
            parserState.sawSse = true;
            parseSseBlock(record, block);
        }
    }

    if (flush && parserState.buffer.trim()) {
        const block = parserState.buffer;
        parserState.buffer = '';
        if (block.split('\n').some(line => line.startsWith('data:'))) {
            parserState.sawSse = true;
            parseSseBlock(record, block);
        }
    }
}

function inspectNonSsePayload(record, rawText) {
    const text = rawText.trim();
    if (!text) return 'empty';

    try {
        inspectPayload(record, JSON.parse(text));
        return 'json';
    } catch {
        record.parseErrors += 1;
        return 'unknown';
    }
}

async function inspectResponseBody(record, response) {
    if (!response.body) return { format: 'empty', readError: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parserState = { buffer: '', sawSse: false };
    let readError = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            const decoded = decoder.decode(value || new Uint8Array(), { stream: !done });
            appendRawResponse(record, decoded);
            parserState.buffer += decoded;
            drainSseBlocks(record, parserState);
            if (done) break;
        }
    } catch (error) {
        // An AbortController cancellation rejects the stream reader. The chunks already
        // delivered above remain available and must not be discarded.
        readError = error;
    } finally {
        try {
            const tail = decoder.decode();
            appendRawResponse(record, tail);
            parserState.buffer += tail;
        } catch {
            // No pending decoder bytes.
        }
        drainSseBlocks(record, parserState, true);
        reader.releaseLock();
    }

    const format = parserState.sawSse
        ? 'sse'
        : inspectNonSsePayload(record, getRawResponse(record));
    return { format, readError };
}

function finishRecord(record, state = 'complete') {
    record.finishedAt = new Date().toISOString();
    record.state = state;
    history = [record, ...history.filter(item => item.localId !== record.localId)];
    applyRetentionLimit();
    render();
}

function isAbortError(error, signal, record) {
    return Boolean(
        record.abortRequested
        || signal?.aborted
        || error?.name === 'AbortError'
        || /abort|cancel|终止|取消/i.test(String(error?.message || error || ''))
    );
}

async function inspectResponse(record, response, signal, removeAbortListener) {
    try {
        record.httpStatus = response.status;
        record.responseHeaders = readAllowedHeaders(response);
        record.responseContentType = response.headers.get('content-type') || null;

        const { format, readError } = await inspectResponseBody(record, response);
        record.detectedResponseFormat = format;

        if (readError) {
            throw readError;
        }

        if (format === 'empty') record.error = 'Body phản hồi trống';
        if (format === 'unknown') record.error = 'Phản hồi không phải định dạng SSE hoặc JSON có thể phân tích';

        const wasAborted = record.abortRequested || signal?.aborted;
        finishRecord(record, wasAborted && !record.sawDoneMarker ? 'aborted' : (response.ok ? 'complete' : 'http-error'));
    } catch (error) {
        const wasAborted = isAbortError(error, signal, record);
        record.error = wasAborted
            ? 'Người dùng đã hủy yêu cầu; đã giữ lại phản hồi gốc nhận được trước khi hủy'
            : (error instanceof Error ? error.message : String(error));
        finishRecord(record, wasAborted ? 'aborted' : 'inspect-error');
    } finally {
        removeAbortListener?.();
    }
}

function installFetchObserver() {
    if (window[PATCH_KEY]) return;

    const originalFetch = window.fetch.bind(window);
    window[PATCH_KEY] = { originalFetch };

    window.fetch = async function streamHelperFetch(input, init) {
        if (!isTargetRequest(input)) return originalFetch(input, init);

        const rawRequest = readRawRequestBody(init);
        const record = newRecord(readRequestedModel(input, init));
        rawEntry(record).request = rawRequest;
        history = [record, ...history];
        applyRetentionLimit();
        render();

        const signal = init?.signal;
        const onAbort = () => {
            record.abortRequested = true;
            render();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);

        try {
            const response = await originalFetch(input, init);
            void inspectResponse(record, response.clone(), signal, removeAbortListener);
            return response;
        } catch (error) {
            removeAbortListener();
            record.error = error instanceof Error ? error.message : String(error);
            finishRecord(record, isAbortError(error, signal, record) ? 'aborted' : 'request-error');
            throw error;
        }
    };
}

function sortedCounts(counter) {
    return Object.entries(counter || {}).sort((a, b) => b[1] - a[1]);
}

function normalizeModelForComparison(value) {
    const model = firstString(value);
    if (!model) return null;

    // Build a comparison key without changing the raw name shown to the user.
    // Normalize display variants, routing tags, provider paths, case, and separators.
    let candidate = model.normalize('NFKC').trim();
    candidate = candidate.replace(/^(?:\[[^\]\r\n]{1,32}\]\s*)+/, '').trim();

    const pathSegments = candidate.split('/').map(item => item.trim()).filter(Boolean);
    candidate = pathSegments[pathSegments.length - 1] || candidate;
    candidate = candidate.replace(/^(?:\[[^\]\r\n]{1,32}\]\s*)+/, '').trim();

    const tokens = candidate.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return tokens?.join(':') || candidate.toLowerCase() || model.toLowerCase();
}

function comparableModelCounts(counter) {
    const groupedCounts = new Map();
    for (const [model, count] of Object.entries(counter || {})) {
        const comparableModel = normalizeModelForComparison(model);
        if (!comparableModel) continue;
        groupedCounts.set(comparableModel, (groupedCounts.get(comparableModel) || 0) + count);
    }
    return [...groupedCounts.entries()].sort((a, b) => b[1] - a[1]);
}

function modelNamesEqual(left, right) {
    const comparableLeft = normalizeModelForComparison(left);
    const comparableRight = normalizeModelForComparison(right);
    return Boolean(comparableLeft && comparableRight && comparableLeft === comparableRight);
}

function verdictFor(record) {
    if (record.state === 'running') return { key: 'running', label: 'Đang nhận' };
    if (record.state === 'aborted') return { key: 'warning', label: 'Người dùng đã hủy (đã giữ lại phần đã nhận)' };
    if (record.state !== 'complete') return { key: 'error', label: 'Kiểm tra thất bại' };

    const contentModels = comparableModelCounts(record.contentModelCounts);
    const streamModels = comparableModelCounts(record.streamModelCounts);
    const evidenceModels = contentModels.length ? contentModels : streamModels;
    const primaryModel = evidenceModels[0]?.[0] || null;
    const anomalies = [];

    if (!primaryModel) anomalies.push('Phản hồi không báo cáo model');
    if (contentModels.length > 1) anomalies.push('Model phân mảnh body bị lẫn lộn');
    if (record.requestedModel && primaryModel && !modelNamesEqual(record.requestedModel, primaryModel)) {
        anomalies.push('Model yêu cầu và model body khác nhau');
    }
    if (record.finalUsageModel && primaryModel && !modelNamesEqual(record.finalUsageModel, primaryModel)) {
        anomalies.push('Thẻ usage cuối cùng và model body khác nhau');
    }

    if (anomalies.length) return { key: 'warning', label: anomalies.join('; ') };
    return { key: 'ok', label: 'Giao diện báo cáo nhất quán' };
}

function formatTime(value) {
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).format(new Date(value));
    } catch {
        return value || '—';
    }
}

function addText(parent, className, text) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
}

function countText(counter) {
    const entries = sortedCounts(counter);
    return entries.length ? entries.map(([model, count]) => `${model} × ${count}`).join(', ') : 'Chưa báo cáo';
}

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Trình duyệt đã từ chối thao tác clipboard');
}

function makeCopyButton(label, textProvider, unavailableReason) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stsh-copy-button';
    button.textContent = label;
    const initialText = textProvider();
    button.disabled = typeof initialText !== 'string';
    if (button.disabled && unavailableReason) button.title = unavailableReason;

    button.addEventListener('click', async () => {
        const text = textProvider();
        if (typeof text !== 'string') return;
        const originalLabel = button.textContent;
        try {
            await copyText(text);
            button.textContent = 'Đã copy';
        } catch (error) {
            console.error('[Tavern Stream Helper] Copy thất bại.', error);
            button.textContent = 'Copy thất bại';
        }
        setTimeout(() => { button.textContent = originalLabel; }, 1400);
    });

    return button;
}

function buildRecordCard(record) {
    const card = document.createElement('article');
    card.className = 'stsh-card';
    const verdict = verdictFor(record);

    const header = document.createElement('div');
    header.className = 'stsh-card-header';
    addText(header, 'stsh-time', formatTime(record.startedAt));
    addText(header, `stsh-status stsh-status-${verdict.key}`, verdict.label);
    card.append(header);

    const rows = [
        ['Model yêu cầu', record.requestedModel || 'Chưa đọc được'],
        ['Báo cáo phân mảnh body', countText(record.contentModelCounts)],
        ['Báo cáo toàn bộ phân mảnh', countText(record.streamModelCounts)],
        ['Model usage cuối cùng', record.finalUsageModel || 'Chưa báo cáo'],
        ['ID Phản hồi', record.responseId || 'Chưa báo cáo'],
        ['Số sự kiện / Lỗi phân tích', `${record.eventCount} / ${record.parseErrors}`],
        ['Định dạng phản hồi', record.detectedResponseFormat || 'Chưa xác định'],
    ];

    if (record.responseContentType) rows.push(['Content-Type', record.responseContentType]);
    if (record.usageSource) rows.push(['Nguồn tính phí', record.usageSource]);
    if (record.systemFingerprint) rows.push(['Fingerprint hệ thống', record.systemFingerprint]);
    if (Object.keys(record.responseHeaders || {}).length) {
        rows.push(['Header phản hồi', Object.entries(record.responseHeaders).map(([key, value]) => `${key}: ${value}`).join('; ')]);
    }
    if (record.error) rows.push(['Lỗi', record.error]);

    const table = document.createElement('dl');
    table.className = 'stsh-rows';
    for (const [label, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        table.append(dt, dd);
    }
    card.append(table);

    const raw = sessionRaw.get(record.localId);
    const copyActions = document.createElement('div');
    copyActions.className = 'stsh-copy-actions';
    const replyButtonLabel = record.state === 'aborted'
        ? 'Copy phản hồi gốc đã nhận'
        : record.state === 'running'
            ? 'Copy phản hồi gốc hiện tại'
            : 'Copy toàn bộ phản hồi gốc';
    copyActions.append(
        makeCopyButton(
            'Copy toàn bộ input gốc',
            () => raw?.request ?? null,
            'Input hoàn chỉnh chỉ được giữ trong trang hiện tại lúc generate; không thể khôi phục sau khi tải lại trang.',
        ),
        makeCopyButton(
            replyButtonLabel,
            () => raw?.responseChunks?.length ? getRawResponse(record) : null,
            'Chưa nhận được nội dung phản hồi, hoặc nội dung đã bị xóa khi tải lại trang.',
        ),
    );
    card.append(copyActions);
    return card;
}

function ensureUi() {
    if (document.getElementById(`${EXTENSION_ID}-button`)) return;

    const button = document.createElement('button');
    button.id = `${EXTENSION_ID}-button`;
    button.type = 'button';
    button.title = 'Xem lịch sử định tuyến model';
    button.setAttribute('aria-label', 'Xem lịch sử định tuyến model');
    button.innerHTML = '<span class="stsh-button-label">Stream</span><span class="stsh-button-count">0</span>';
    button.addEventListener('click', () => {
        panelOpen = !panelOpen;
        render();
    });

    const panel = document.createElement('aside');
    panel.id = `${EXTENSION_ID}-panel`;
    panel.setAttribute('aria-label', 'Tavern Stream Helper');

    document.body.append(button, panel);
}

function downloadHistory() {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sillytavern-stream-helper-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function render() {
    ensureUi();
    const button = document.getElementById(`${EXTENSION_ID}-button`);
    const panel = document.getElementById(`${EXTENSION_ID}-panel`);
    if (!button || !panel) return;

    applyCountColor(button);
    button.querySelector('.stsh-button-count').textContent = String(history.length);
    panel.classList.toggle('stsh-open', panelOpen);
    panel.replaceChildren();

    const heading = document.createElement('header');
    heading.className = 'stsh-panel-header';
    const titleWrap = document.createElement('div');
    addText(titleWrap, 'stsh-title', 'Tavern Stream Helper');
    addText(titleWrap, 'stsh-subtitle', 'SillyTavern 1.18.0 · Lịch sử và bản gốc chỉ lưu trên bộ nhớ trang hiện tại');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stsh-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Đóng');
    close.addEventListener('click', () => {
        panelOpen = false;
        render();
    });
    heading.append(titleWrap, close);

    const actions = document.createElement('div');
    actions.className = 'stsh-actions';
    const retentionControl = document.createElement('label');
    retentionControl.className = 'stsh-retention-control';
    const retentionPrefix = document.createElement('span');
    retentionPrefix.textContent = 'Giữ lại gần đây';
    const retentionInput = document.createElement('input');
    retentionInput.type = 'number';
    retentionInput.min = String(MIN_HISTORY_LIMIT);
    retentionInput.max = String(MAX_HISTORY_LIMIT);
    retentionInput.step = '1';
    retentionInput.value = String(historyLimit);
    retentionInput.title = `Có thể thiết lập ${MIN_HISTORY_LIMIT}–${MAX_HISTORY_LIMIT} bản ghi`;
    retentionInput.setAttribute('aria-label', 'Số lượng bản ghi tự động giữ lại');
    retentionInput.addEventListener('change', () => {
        historyLimit = normalizeHistoryLimit(retentionInput.value, historyLimit);
        saveSettings();
        applyRetentionLimit();
        render();
    });
    const retentionSuffix = document.createElement('span');
    retentionSuffix.textContent = 'bản ghi';
    retentionControl.append(retentionPrefix, retentionInput, retentionSuffix);

    const colorControl = document.createElement('label');
    colorControl.className = 'stsh-color-control';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = 'Màu vòng số';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = countColor || themeCountColorForPicker();
    colorInput.setAttribute('aria-label', 'Chọn màu tùy chỉnh cho vòng số');
    const colorMode = document.createElement('span');
    colorMode.className = 'stsh-color-mode';
    const resetColorButton = document.createElement('button');
    resetColorButton.type = 'button';
    resetColorButton.className = 'stsh-reset-color';
    resetColorButton.textContent = 'Khôi phục màu theme';

    const updateColorControl = () => {
        const usingCustomColor = Boolean(countColor);
        colorMode.textContent = usingCustomColor ? 'Tùy chỉnh' : 'Theme';
        colorInput.title = usingCustomColor
            ? `Màu tùy chỉnh hiện tại: ${countColor}`
            : 'Hiện đang theo màu theme SillyTavern';
        resetColorButton.disabled = !usingCustomColor;
        resetColorButton.title = usingCustomColor ? 'Đổi lại theo màu theme SillyTavern' : 'Hiện đã theo màu theme';
    };

    const selectCountColor = () => {
        const selectedColor = normalizeCountColor(colorInput.value);
        if (!selectedColor) return;
        countColor = selectedColor;
        applyCountColor(button);
        updateColorControl();
    };

    colorInput.addEventListener('input', selectCountColor);
    colorInput.addEventListener('change', () => {
        selectCountColor();
        saveSettings();
    });
    resetColorButton.addEventListener('click', () => {
        countColor = null;
        saveSettings();
        applyCountColor(button);
        colorInput.value = themeCountColorForPicker();
        updateColorControl();
    });
    updateColorControl();
    colorControl.append(colorLabel, colorInput, colorMode);

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'Xuất JSON';
    exportButton.disabled = history.length === 0;
    exportButton.addEventListener('click', downloadHistory);
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = 'Xóa lịch sử';
    clearButton.disabled = history.length === 0;
    clearButton.addEventListener('click', () => {
        if (!confirm('Xóa lịch sử cục bộ của Tavern Stream Helper?')) return;
        history = [];
        sessionRaw.clear();
        render();
    });
    actions.append(retentionControl, colorControl, resetColorButton, exportButton, clearButton);

    const list = document.createElement('div');
    list.className = 'stsh-list';
    if (history.length === 0) {
        addText(list, 'stsh-empty', 'Chưa có lịch sử. Yêu cầu chat completion tiếp theo sẽ tự động xuất hiện ở đây.');
    } else {
        history.forEach(record => list.append(buildRecordCard(record)));
    }

    panel.append(heading, actions, list);
}

function init() {
    clearLegacyHistory();
    applyRetentionLimit();
    saveSettings();
    installFetchObserver();
    render();
    console.info('[Tavern Stream Helper] Đã bật; lịch sử yêu cầu, input hoàn chỉnh và phản hồi gốc chỉ được lưu tạm thời trên bộ nhớ trang hiện tại.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}