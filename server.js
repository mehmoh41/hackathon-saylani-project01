'use strict';

// --- 1. IMPORT LIBRARIES ---
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Always load .env next to this file
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 3000;

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 2. SUPABASE CLIENT SETUP ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const conversationsTable = process.env.SUPABASE_CONVERSATIONS_TABLE || 'support_conversations';
const faqTable = process.env.SUPABASE_FAQ_TABLE || 'faqs';
const feedbackTable = process.env.SUPABASE_FEEDBACK_TABLE || 'feedbacks';
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client initialised');
} else {
    console.warn('⚠️ Supabase credentials are missing; skipping DB logging.');
}

let geminiClient = null;
if (geminiApiKey) {
    geminiClient = new GoogleGenerativeAI(geminiApiKey);
    console.log('✅ Gemini client initialised');
} else {
    console.warn('⚠️ Gemini API key missing; fallback will use default message.');
}

// Generate response using Gemini (or fallback)
async function generateFallbackResponse(prompt) {
    if (!geminiClient) {
        console.warn('⚠️ Gemini client not available; using default fallback message.');
        return "I'm sorry, I didn't catch that. Could you please rephrase?";
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: geminiModel });
        const result = await model.generateContent(prompt);
        // FIXED: Optional chaining used correctly (no space)
        const candidateText = result ? .response ? .text ? .trim();
        return candidateText || "I'm sorry, I still didn't understand. Could you please clarify?";
    } catch (error) {
        console.error('❌ Gemini fallback failed:', error);
        return "I'm sorry, I didn't catch that. Could you please rephrase?";
    }
}

// --- 3. HELPER FUNCTIONS ---
const CHIP_IMAGES = {
    support: 'https://www.svgrepo.com/show/485554/customer-support.svg',
    faq: 'https://www.svgrepo.com/show/488191/faq.svg',
    feedback: 'https://www.svgrepo.com/show/339196/feedback-02.svg'
};

const faqPendingSessions = new Set();
const feedbackPendingSessions = new Set();

const FAQ_PREDEFINED = [
    { question: "How can I contact customer support?", answer: "You can reach our customer support team through live chat, email, or by submitting a ticket on our support page. Our team is available 24/7." },
    { question: "What is the average response time?", answer: "Our typical response time is a few minutes via live chat, and within 12–24 hours for email or ticket inquiries." },
    { question: "How do I create an account?", answer: "Click 'Sign Up' on our website, enter your details, and verify your email." },
    { question: "I forgot my password. How can I reset it?", answer: "Use the 'Forgot Password' link on the login page, enter your registered email, and follow the link to reset your password." },
    { question: "How do I track my order or request?", answer: "Log into your account, then go to the 'Orders' or 'Requests' section in your dashboard." },
    { question: "What payment methods do you accept?", answer: "We accept major credit/debit cards, bank transfers, PayPal, and supported wallets." },
    { question: "Can I modify or cancel my order?", answer: "You can modify/cancel your order within a limited window from your dashboard. If not, contact support." },
    { question: "Do you offer refunds?", answer: "Refunds are possible according to our policy. Submit a request via your account or contact support." },
    { question: "How can I update my profile or account information?", answer: "Go to 'Account Settings' after logging in to update your info." },
    { question: "Is my personal information secure?", answer: "Yes, we use industry-standard encryption and security practices to protect your data." },
    { question: "Do you provide support for technical issues?", answer: "Yes — for troubleshooting, installation, configuration, and general product assistance." },
    { question: "Where can I find tutorials or documentation?", answer: "All guides and docs are in the 'Help Center' section of our site." }
];

const FAQ_ANSWER_MAP = FAQ_PREDEFINED.reduce((acc, item) => {
    const key = item.question.trim().toLowerCase();
    acc[key] = item.answer;
    return acc;
}, {});

function normalizeString(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'object') {
        if (value.name) return String(value.name).trim() || null;
        if (value.original) return String(value.original).trim() || null;
        if (value.displayName) return String(value.displayName).trim() || null;
    }
    return null;
}

function extractName(params) {
    return normalizeString(
        // FIXED: Optional chaining used correctly (no space)
        params ? .name ||
        params ? .person ? .name ||
        params ? .person ? .original ||
        params['given-name']
    );
}

function extractEmail(params) {
    return normalizeString(
        // FIXED: Optional chaining used correctly (no space)
        params ? .email ||
        params ? .emailAddress ||
        params['email-address']
    );
}

function extractUserMessage(params, fallbackText) {
    return normalizeString(
        // FIXED: Optional chaining used correctly (no space)
        params ? .problem ||
        params ? .issue ||
        params ? .message ||
        params['problem-description'] ||
        params['customer_message'] ||
        fallbackText
    );
}

function extractRating(params) {
    // FIXED: Optional chaining used correctly (no space)
    const r = params ? .rating || params ? .score || params ? .['feedback-rating'];
    if (r === undefined || r === null) return null;
    const parsed = parseFloat(r);
    return Number.isNaN(parsed) ? null : parsed;
}

function extractFaqTopic(params, fallbackText) {
    return normalizeString(
        // FIXED: Optional chaining used correctly (no space)
        params ? .topic ||
        params ? .subject ||
        params ? .['faq-topic'] ||
        fallbackText
    );
}

// Generic function to sanitize a record before saving
function sanitizeRecord(record) {
    const sanitized = {};
    for (const [key, value] of Object.entries(record)) {
        if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
            sanitized[key] = null;
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

async function saveConversationRecord(record) {
    if (!supabase) {
        console.warn('⏭️ Skipping Supabase insert: client not initialised.');
        return;
    }

    const sanitized = sanitizeRecord(record);
    const { data, error } = await supabase
        .from(conversationsTable)
        .insert([sanitized])
        .select();

    if (error) {
        console.error('❌ Failed to store conversation:', error);
    } else {
        // FIXED: Optional chaining used correctly (no space)
        const insertedId = data ? .[0] ? .id ? ? null;
        console.log('💾 Conversation stored, id =', insertedId);
    }
}

async function saveFaqRecord(record) {
    if (!supabase) {
        console.warn('⏭️ Skipping Supabase insert for FAQ: client not initialised.');
        return;
    }

    const sanitized = sanitizeRecord(record);
    const { data, error } = await supabase
        .from(faqTable)
        .insert([sanitized])
        .select();

    if (error) {
        console.error('❌ Failed to store FAQ:', error);
    } else {
        // FIXED: Optional chaining used correctly (no space)
        const insertedId = data ? .[0] ? .id ? ? null;
        console.log('💾 FAQ stored, id =', insertedId);
    }
}

async function saveFeedbackRecord(record) {
    if (!supabase) {
        console.warn('⏭️ Skipping Supabase insert for feedback: client not initialised.');
        return;
    }

    const sanitized = sanitizeRecord(record);
    const { data, error } = await supabase
        .from(feedbackTable)
        .insert([sanitized])
        .select();

    if (error) {
        console.error('❌ Failed to store feedback:', error);
    } else {
        // FIXED: Optional chaining used correctly (no space)
        const insertedId = data ? .[0] ? .id ? ? null;
        console.log('💾 Feedback stored, id =', insertedId);
    }
}

function buildChipsPayload(options) {
    return {
        payload: {
            richContent: [
                [{
                    type: 'chips',
                    options,
                }, ],
            ],
        },
    };
}

function buildMissingFieldsResponse(missing) {
    const text = `I still need your ${missing.join(' and ')}. Please provide the remaining detail(s).`;
    return {
        fulfillmentMessages: [{
            text: { text: [text] },
        }, ],
    };
}

// --- 4. WEBHOOK ROUTE ---
app.post('/dialogflow', async(req, res) => {
    try {
        console.log('👉 Request received!');

        const body = req.body;
        const queryResult = body.queryResult || {};
        // FIXED: Optional chaining used correctly (no space)
        const detectedIntent = queryResult.intent ? .displayName;
        const parameters = queryResult.parameters || {};
        const sessionId = body.session || body.sessionId || body.responseId;
        // FIXED: Optional chaining used correctly (no space)
        const channel = body.originalDetectIntentRequest ? .source || 'dialogflow';
        const queryText = queryResult.queryText || '';
        const intentConfidence = queryResult.intentDetectionConfidence;
        const fallbackThreshold = parseFloat(process.env.FALLBACK_CONFIDENCE_THRESHOLD || '0.6');

        const chipIntentMap = {
            'customer support': 'Customer Support',
            'faq': 'FAQ',
            'frequently asked questions': 'FAQ',
            'feedback': 'Feedback',
            'leave feedback': 'Feedback'
        };

        let intentName = detectedIntent;
        const normalizedQuery = queryText.trim().toLowerCase();
        if (chipIntentMap[normalizedQuery]) {
            intentName = chipIntentMap[normalizedQuery];
            console.log(`🔁 Overriding intent based on chip: ${intentName}`);
        }

        const hasPendingFaq = faqPendingSessions.has(sessionId);
        const hasPendingFeedback = feedbackPendingSessions.has(sessionId);

        if (hasPendingFaq && intentName !== 'FAQ') {
            console.log('🔁 Forcing to FAQ due to pending FAQ session');
            intentName = 'FAQ';
        } else if (hasPendingFeedback && intentName !== 'Feedback') {
            console.log('🔁 Forcing to Feedback due to pending feedback session');
            intentName = 'Feedback';
        }

        // --- Handle Intents ---
        if (intentName === 'Default Welcome Intent') {
            const welcome = [
                { text: 'Welcome to Our Virtual Assistant. How can I help you today?' },
                { text: 'Please select a category below:' },
            ];

            const chips = buildChipsPayload([
                { text: 'Customer Support', image: { src: { rawUrl: CHIP_IMAGES.support } } },
                { text: 'FAQ', image: { src: { rawUrl: CHIP_IMAGES.faq } } },
                { text: 'Feedback', image: { src: { rawUrl: CHIP_IMAGES.feedback } } }
            ]);

            return res.json({
                fulfillmentMessages: [
                    { text: { text: [welcome[0].text] } },
                    { text: { text: [welcome[1].text] } },
                    chips,
                ]
            });
        }

        if (intentName === 'Customer Support') {
            console.log('✅ Customer Support flow');

            // If confidence is too low, do fallback
            if (typeof intentConfidence === 'number' && intentConfidence < fallbackThreshold) {
                const fallback = await generateFallbackResponse(queryText || 'Hello');

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: intentName,
                    user_message: queryText,
                    channel,
                    response_text: fallback,
                    intent_confidence: intentConfidence,
                    used_gemini: true,
                    fallback_reason: 'low_confidence'
                });

                return res.json({ fulfillmentText: fallback });
            }

            // Extract info
            const userName = extractName(parameters);
            const userEmail = extractEmail(parameters);
            const userMessage = extractUserMessage(parameters, queryText);

            const missing = [];
            if (!userName) missing.push('name');
            if (!userEmail) missing.push('email');
            if (!userMessage) missing.push('message');

            if (missing.length) {
                return res.json(buildMissingFieldsResponse(missing));
            }

            const reply = `Thanks ${userName}! I have logged your request. Our team will reach out soon at ${userEmail}.`;

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_name: userName,
                user_email: userEmail,
                user_message: userMessage,
                channel,
                response_text: reply,
                intent_confidence: intentConfidence,
                used_gemini: false,
                record_type: 'support'
            });

            return res.json({
                fulfillmentMessages: [
                    { text: { text: [reply] } }
                ]
            });
        }

        if (intentName === 'FAQ') {
            console.log('✅ FAQ flow');

            const normalizedText = queryText.trim().toLowerCase();
            const isChip = normalizedText === 'faq' || normalizedText === 'frequently asked questions';

            if (isChip) {
                const promptText = 'Here are some FAQs. Tap one or type your own question.';
                faqPendingSessions.add(sessionId);

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: intentName,
                    user_message: queryText,
                    channel,
                    response_text: promptText,
                    record_type: 'faq_start',
                    intent_confidence: intentConfidence,
                    used_gemini: false
                });

                return res.json({
                    fulfillmentMessages: [
                        { text: { text: [promptText] } },
                        buildChipsPayload(FAQ_PREDEFINED.map(item => ({ text: item.question })))
                    ]
                });
            }

            // User typed question
            const userName = extractName(parameters);
            const userEmail = extractEmail(parameters);
            const faqQuestion = extractFaqTopic(parameters, queryText);

            // FIXED: Using logical AND (&&) as requested for safe string method chaining
            const normQ = faqQuestion && faqQuestion.trim().toLowerCase();

            const predefined = FAQ_ANSWER_MAP[normQ];

            let faqAnswer;
            let usedGemini = false;
            if (predefined) {
                faqAnswer = predefined;
            } else {
                const prompt = `User is asking: "${faqQuestion}". Provide a simple, clear answer.`;
                faqAnswer = await generateFallbackResponse(prompt);
                usedGemini = true;
            }

            faqPendingSessions.delete(sessionId);

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_name: userName,
                user_email: userEmail,
                user_message: faqQuestion,
                channel,
                response_text: faqAnswer,
                record_type: 'faq',
                intent_confidence: intentConfidence,
                used_gemini: usedGemini
            });

            await saveFaqRecord({
                session_id: sessionId,
                user_name: userName,
                user_email: userEmail,
                question_text: faqQuestion,
                answer_text: faqAnswer,
                channel,
                intent_name: intentName,
                intent_confidence: intentConfidence,
                used_gemini: usedGemini
            });

            return res.json({
                fulfillmentMessages: [
                    { text: { text: [faqAnswer] } }
                ]
            });
        }

        if (intentName === 'Feedback') {
            console.log('✅ Feedback flow');

            const normalizedText = queryText.trim().toLowerCase();
            const isChip = normalizedText === 'feedback' || normalizedText === 'leave feedback';

            if (isChip) {
                const prompt = 'Please type your feedback below.';
                feedbackPendingSessions.add(sessionId);

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: intentName,
                    user_message: queryText,
                    channel,
                    response_text: prompt,
                    record_type: 'feedback_start',
                    intent_confidence: intentConfidence,
                    used_gemini: false
                });

                return res.json({
                    fulfillmentMessages: [
                        { text: { text: [prompt] } }
                    ]
                });
            }

            // User provided feedback
            const userName = extractName(parameters);
            const userEmail = extractEmail(parameters);
            const feedbackText = extractUserMessage(parameters, queryText);
            const feedbackRating = extractRating(parameters);

            feedbackPendingSessions.delete(sessionId);
            const thankYou = 'Thanks for your feedback — it really helps us!';

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_name: userName,
                user_email: userEmail,
                user_message: feedbackText,
                channel,
                response_text: thankYou,
                feedback_rating: feedbackRating,
                record_type: 'feedback',
                intent_confidence: intentConfidence,
                used_gemini: false
            });

            await saveFeedbackRecord({
                session_id: sessionId,
                user_name: userName,
                user_email: userEmail,
                feedback_text: feedbackText,
                feedback_rating: feedbackRating,
                channel,
                intent_name: intentName,
                intent_confidence: intentConfidence,
                used_gemini: false
            });

            return res.json({
                fulfillmentMessages: [
                    { text: { text: [thankYou] } }
                ]
            });
        }

        // --- Fallback Handler ---
        console.log('⚙️ Fallback handler triggered');
        const fallback = await generateFallbackResponse(queryText || 'Hello');

        await saveConversationRecord({
            session_id: sessionId,
            intent_name: intentName,
            user_message: queryText,
            channel,
            response_text: fallback,
            intent_confidence: intentConfidence,
            used_gemini: true,
            fallback_reason: 'unknown_intent'
        });

        return res.json({
            fulfillmentText: fallback
        });
    } catch (err) {
        console.error('❌ Webhook Error:', err);
        return res.json({
            fulfillmentText: 'Something went wrong. Please try again later.'
        });
    }
});

// --- ADMIN ROUTES ---
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/overview', async(req, res) => {
    if (!supabase) {
        return res.status(500).json({ error: 'Supabase not initialised.' });
    }

    try {
        const [
            convCountRes,
            faqCountRes,
            feedbackCountRes,
            convRowsRes,
            faqRowsRes
        ] = await Promise.all([
            supabase.from(conversationsTable).select('*', { count: 'exact', head: true }),
            supabase.from(faqTable).select('*', { count: 'exact', head: true }),
            supabase.from(feedbackTable).select('*', { count: 'exact', head: true }),
            supabase
            .from(conversationsTable)
            .select('id, session_id, intent_name, user_name, user_email, created_at, used_gemini, fallback_reason')
            .order('created_at', { ascending: false })
            .limit(100),
            supabase
            .from(faqTable)
            .select('id, question_text, created_at')
            .order('created_at', { ascending: false })
            .limit(500)
        ]);

        if (convCountRes.error || faqCountRes.error || feedbackCountRes.error || convRowsRes.error || faqRowsRes.error) {
            console.error('❌ Admin overview query error', {
                convError: convCountRes.error,
                faqError: faqCountRes.error,
                feedbackError: feedbackCountRes.error,
                convRowsError: convRowsRes.error,
                faqRowsError: faqRowsRes.error
            });
            return res.status(500).json({ error: 'Failed to get admin data' });
        }

        const totals = {
            conversations: convCountRes.count || 0,
            faqs: faqCountRes.count || 0,
            feedbacks: feedbackCountRes.count || 0
        };

        const convRows = convRowsRes.data || [];
        const faqRows = faqRowsRes.data || [];

        const geminiUsage = {};
        const fallbackCounts = {};
        const userLastSeen = {};

        for (const row of convRows) {
            const intent = row.intent_name || 'Unknown';
            if (row.used_gemini) {
                geminiUsage[intent] = (geminiUsage[intent] || 0) + 1;
                if (row.fallback_reason) {
                    const key = `${intent}|${row.fallback_reason}`;
                    fallbackCounts[key] = (fallbackCounts[key] || 0) + 1;
                }
            }
            if (row.user_email) {
                const email = row.user_email;
                const last = userLastSeen[email];
                if (!last || new Date(row.created_at) > new Date(last.last_seen)) {
                    userLastSeen[email] = {
                        user_email: email,
                        user_name: row.user_name,
                        last_seen: row.created_at
                    };
                }
            }
        }

        const geminiUsageByIntent = Object.entries(geminiUsage).map(([intent_name, count]) => ({ intent_name, count }));
        const fallbackList = Object.entries(fallbackCounts).map(([key, count]) => {
            const [intent_name, fallback_reason] = key.split('|');
            return { intent_name, fallback_reason, count };
        });

        const faqCountMap = {};
        for (const row of faqRows) {
            const q = row.question_text || 'Unknown';
            faqCountMap[q] = (faqCountMap[q] || 0) + 1;
        }

        const topFaqs = Object.entries(faqCountMap)
            .map(([question_text, count]) => ({ question_text, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const recentUsers = Object.values(userLastSeen)
            .sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))
            .slice(0, 20);

        return res.json({
            totals,
            geminiUsageByIntent,
            fallbackList,
            topFaqs,
            recentConversations: convRows,
            recentUsers
        });
    } catch (err) {
        console.error('❌ Error building admin overview:', err);
        return res.status(500).json({ error: 'Failed to build admin overview' });
    }
});

app.listen(port, () => {
    console.log(`Bot server running on port ${port}`);
});