export type Intent =
    | { type: 'list-sessions' }
    | { type: 'summarize-all' }
    | { type: 'summarize-one'; sessionRef: number } // 1-based index
    | { type: 'interrupt'; sessionRef: number; message: string }
    | { type: 'send-message'; sessionRef: number; message: string }
    | { type: 'find-and-summarize'; query: string }
    | { type: 'find-and-interrupt'; query: string; message: string }
    | { type: 'find-and-send'; query: string; message: string }
    | { type: 'spawn-session'; directory: string }
    | { type: 'help' }
    | { type: 'unknown' };

const LIST_PATTERNS = [
    /\b(list|show|what|which|how many)\b.*\bsession/i,
    /\bwhat('s| is) (running|happening|going on|active)/i,
    /\bsession(s)?\b/i,
];

const SUMMARIZE_ALL_PATTERNS = [
    /\bsummariz(e|ing)\b.*\ball\b/i,
    /\boverall (summary|status|progress)/i,
    /\bsummariz(e|ing)\b(?!.*session\s*\d)/i,
    /\bwhat('s| are) (you|they|claude|the agent) (doing|working on)/i,
    /\bprogress\b/i,
    /\bstatus\b/i,
];

const SUMMARIZE_ONE_PATTERNS = [
    /\bsummariz(e|ing)\b.*session\s*(\d+)/i,
    /\bwhat('s| is)\b.*session\s*(\d+)\b/i,
    /\bsession\s*(\d+)\b.*\b(doing|working|summary|status|progress)/i,
    /\bnumber\s*(\d+)\b/i,
];

const INTERRUPT_PATTERNS = [
    /\b(tell|ask|instruct|interrupt|stop|pause|send)\b.*(session\s*(\d+)|number\s*(\d+))/i,
    /\bsession\s*(\d+)\b.*\b(stop|pause|tell|ask|message)/i,
];

const SPAWN_PATTERNS = [
    /\b(start|create|open|launch|new)\b.*\b(session|project|workspace)\b.*?([~\/][^\s]*)/i,
    /\bnew session\b.*in\s+([~\/][^\s]+)/i,
];

// Patterns that signal a find-by-description command
const FIND_SESSION_TRIGGERS = [
    /\bfind\b.*\bsession\b/i,
    /\blocate\b.*\bsession\b/i,
    /\bsession\b.*\b(that|which|who)\b.*\b(is|was|working|doing|about)\b/i,
    /\bwhich session\b.*\b(is|was|working|doing|has)\b/i,
    /\bthe session\b.*\b(working on|about|for|doing)\b/i,
];

function extractSessionNumber(text: string): number | null {
    const m = text.match(/\b(\d+)\b/);
    return m ? parseInt(m[1], 10) : null;
}

function extractAfterColon(text: string): string {
    const idx = text.indexOf(':');
    if (idx !== -1) return text.slice(idx + 1).trim();
    const m = text.match(/\b(tell|ask|instruct|send|message)\b.*(session\s*\d+|number\s*\d+)[,:]?\s*(.+)/i);
    if (m) return m[3].trim();
    return '';
}

// Split "find the session working on X[, and] <action>" into the two halves
function splitFindCommand(text: string): { findPart: string; actionPart: string } {
    // Separators: ", and", " and then", " then", ",", "?"
    const m = text.match(/^(.+?)(?:,\s*(?:and\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+|\?\s*)(.+)$/i);
    if (m) return { findPart: m[1].trim(), actionPart: m[2].trim() };
    return { findPart: text, actionPart: '' };
}

// Extract the search query from the "find" half
function extractFindQuery(findPart: string): string | null {
    // "working on X" / "about X" / "for X" / "related to X" / "on X"
    const afterPrep = findPart.match(
        /\b(?:working\s+on|about|for|related\s+to|doing)\s+(.+)/i,
    );
    if (afterPrep) return afterPrep[1].trim();

    // "that(?:'s)? working X" or "that(?:'s)? is working on X"
    const thatWorking = findPart.match(
        /\bthat(?:'s|)?\s+(?:is\s+)?(?:working(?:\s+on)?|doing)\s+(.+)/i,
    );
    if (thatWorking) return thatWorking[1].trim();

    // "that <query>" — e.g., "the session that abc"
    const thatFallback = findPart.match(/\bsession\b.*?\bthat\b\s+(.+)/i);
    if (thatFallback) return thatFallback[1].trim();

    return null;
}

type FindAction =
    | { type: 'summarize' }
    | { type: 'interrupt'; message: string }
    | { type: 'send'; message: string };

function extractFindAction(actionPart: string): FindAction {
    if (!actionPart) return { type: 'summarize' };

    const lower = actionPart.toLowerCase();

    // Summarize cues
    if (/\b(tell me|show me|what('s| is)|summariz|progress|status|how('s| is)|current)\b/.test(lower)) {
        return { type: 'summarize' };
    }

    // Send a specific message (colon separator)
    const colonIdx = actionPart.indexOf(':');
    if (colonIdx !== -1 && /\b(tell|send|message|instruct|ask)\b/.test(lower)) {
        return { type: 'send', message: actionPart.slice(colonIdx + 1).trim() };
    }

    // Tell it to <do something>
    const tellTo = actionPart.match(/\b(?:tell|ask|instruct)\s+it\s+to\s+(.+)/i);
    if (tellTo) return { type: 'send', message: tellTo[1].trim() };

    // Stop / pause / interrupt
    if (/\b(stop|pause|interrupt|halt)\b/.test(lower)) {
        return { type: 'interrupt', message: 'Please pause and wait for my instructions.' };
    }

    // Default: summarize
    return { type: 'summarize' };
}

export function parseIntent(text: string): Intent {
    const lower = text.toLowerCase().trim();

    if (/\bhelp\b/.test(lower)) return { type: 'help' };

    // Spawn session
    for (const pat of SPAWN_PATTERNS) {
        const m = text.match(pat);
        if (m) {
            const dir = m[m.length - 1]?.replace(/^~/, process.env.HOME ?? '~') ?? '~/';
            return { type: 'spawn-session', directory: dir };
        }
    }

    // Find-by-description (must check before numeric patterns to avoid false matches)
    const isFindCommand = FIND_SESSION_TRIGGERS.some((pat) => pat.test(text));
    if (isFindCommand && !/session\s*\d+/i.test(text)) {
        const { findPart, actionPart } = splitFindCommand(text);
        const query = extractFindQuery(findPart);
        if (query) {
            const action = extractFindAction(actionPart);
            if (action.type === 'summarize') return { type: 'find-and-summarize', query };
            if (action.type === 'interrupt') return { type: 'find-and-interrupt', query, message: action.message };
            return { type: 'find-and-send', query, message: action.message };
        }
    }

    // Interrupt / send-message with numeric ref
    for (const pat of INTERRUPT_PATTERNS) {
        if (pat.test(text)) {
            const num = extractSessionNumber(text);
            if (num !== null) {
                const msg = extractAfterColon(text);
                return msg
                    ? { type: 'send-message', sessionRef: num, message: msg }
                    : { type: 'interrupt', sessionRef: num, message: 'Please pause and wait for my instructions.' };
            }
        }
    }

    // Summarize one by number
    for (const pat of SUMMARIZE_ONE_PATTERNS) {
        if (pat.test(text)) {
            const num = extractSessionNumber(text);
            if (num !== null) return { type: 'summarize-one', sessionRef: num };
        }
    }

    // Summarize all
    for (const pat of SUMMARIZE_ALL_PATTERNS) {
        if (pat.test(lower)) return { type: 'summarize-all' };
    }

    // List sessions
    for (const pat of LIST_PATTERNS) {
        if (pat.test(lower)) return { type: 'list-sessions' };
    }

    return { type: 'unknown' };
}
