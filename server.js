'use strict';

// --- 1. IMPORT LIBRARIES ---
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Always load .env that sits next to this file, regardless of where node is started
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 3000;

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
    console.warn('⚠️  Supabase credentials are missing. Conversation logging will be skipped.');
}

let geminiClient = null;
if (geminiApiKey) {
    geminiClient = new GoogleGenerativeAI(geminiApiKey);
    console.log('✅ Gemini client initialised');
} else {
    console.warn('⚠️  Gemini API key missing; fallback will use default message.');
}

async function generateFallbackResponse(prompt) {
    if (!geminiClient) {
        console.warn('⚠️  Gemini client not available; using default fallback message.');
        return "I'm sorry, I didn't catch that. Could you please rephrase?";
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: geminiModel });
        const result = await model.generateContent(prompt);
        const candidateText = result?.response?.text()?.trim();
        return candidateText || "I'm sorry, I still didn't understand. Could you please clarify?";
    } catch (error) {
        console.error('❌ Gemini fallback failed:', error.message);
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
  {
    question: "How can I contact customer support?",
    answer:
      "You can reach our customer support team through live chat, email, or by submitting a ticket on our support page. Our team is available 24/7 to assist you."
  },
  {
    question: "What is the average response time?",
    answer:
      "Our typical response time is within a few minutes via live chat and within 12–24 hours for email or ticket inquiries."
  },
  {
    question: "How do I create an account?",
    answer:
      "To create an account, simply click on the 'Sign Up' button on our website, enter your details, and follow the instructions to verify your email."
  },
  {
    question: "I forgot my password. How can I reset it?",
    answer:
      "Click on the 'Forgot Password' option on the login page, enter your registered email, and follow the secure link sent to you to reset your password."
  },
  {
    question: "How do I track my order or request?",
    answer:
      "You can track your order or service request by logging into your account and viewing the 'Orders' or 'Requests' section in your dashboard."
  },
  {
    question: "What payment methods do you accept?",
    answer:
      "We accept major credit and debit cards, bank transfers, PayPal, and supported digital wallets depending on your region."
  },
  {
    question: "Can I modify or cancel my order?",
    answer:
      "Yes, you can modify or cancel your order within a limited time window from your account dashboard. If the option is unavailable, please contact support for assistance."
  },
  {
    question: "Do you offer refunds?",
    answer:
      "Refunds are available based on our refund policy. If eligible, you can submit a refund request through your account or by contacting customer support."
  },
  {
    question: "How can I update my profile or account information?",
    answer:
      "You can update your personal details by going to the 'Account Settings' section after logging into your account."
  },
  {
    question: "Is my personal information secure?",
    answer:
      "Yes, we use industry-standard encryption and security practices to ensure that your data is protected at all times."
  },
  {
    question: "Do you provide support for technical issues?",
    answer:
      "Yes, our technical support team can help with troubleshooting, installation guidance, configuration issues, and general product assistance."
  },
  {
    question: "Where can I find tutorials or documentation?",
    answer:
      "All guides, tutorials, and product documentation are available in the 'Help Center' section of our website."
  }
];


const FAQ_ANSWER_MAP = FAQ_PREDEFINED.reduce((acc, item) => {
    const key = (item.question || '').trim().toLowerCase();
    if (key) acc[key] = item.answer;
    return acc;
}, {});

function normalizeString(value) {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'object') {
        if (value.name) return String(value.name).trim();
        if (value.original) return String(value.original).trim();
        if (value.displayName) return String(value.displayName).trim();
    }
    return null;
}

function extractName(parameters) {
    if (!parameters) return null;
    return normalizeString(
        parameters.name ||
        parameters.person ||
        (parameters.person && parameters.person.name) ||
        (parameters.person && parameters.person.original) ||
        parameters['given-name']
    );
}

function extractEmail(parameters) {
    if (!parameters) return null;
    const email = parameters.email || parameters.emailAddress || parameters['email-address'];
    return normalizeString(email);
}

function extractUserMessage(parameters, fallbackText) {
    if (!parameters) return normalizeString(fallbackText);
    return normalizeString(
        parameters.problem ||
        parameters.issue ||
        parameters.message ||
        parameters['problem-description'] ||
        parameters['customer_message'] ||
        fallbackText
    );
}

function extractRating(parameters) {
    if (!parameters) return null;
    const rating = parameters.rating || parameters.score || parameters['feedback-rating'];
    if (rating === undefined || rating === null) return null;
    if (typeof rating === 'number') return rating;
    const normalized = normalizeString(rating);
    const parsed = parseFloat(normalized);
    return Number.isNaN(parsed) ? null : parsed;
}

function extractFaqTopic(parameters, fallbackText) {
    if (!parameters) return normalizeString(fallbackText);
    return normalizeString(
        parameters.topic ||
        parameters.subject ||
        parameters['faq-topic'] ||
        fallbackText
    );
}

async function saveConversationRecord(record) {
    if (!supabase) {
        console.warn('⏭️  Skipping Supabase insert because client is not initialised.');
        return;
    }

    const sanitizedRecord = Object.entries(record).reduce((acc, [key, value]) => {
        if (value === undefined) {
            acc[key] = null;
        } else if (typeof value === 'string' && value.trim() === '') {
            acc[key] = null;
        } else {
            acc[key] = value;
        }
        return acc;
    }, {});

    const { data, error } = await supabase.from(conversationsTable).insert([sanitizedRecord]).select();
    if (error) {
        console.error('❌ Failed to store conversation in Supabase:', error.message);
    } else {
        console.log('💾 Conversation stored in Supabase', data?.[0]?.id || '');
    }
}

async function saveFaqRecord(record) {
    if (!supabase) {
        console.warn('⏭️  Skipping Supabase insert because client is not initialised.');
        return;
    }

    const sanitizedRecord = Object.entries(record).reduce((acc, [key, value]) => {
        if (value === undefined) {
            acc[key] = null;
        } else if (typeof value === 'string' && value.trim() === '') {
            acc[key] = null;
        } else {
            acc[key] = value;
        }
        return acc;
    }, {});

    const { data, error } = await supabase.from(faqTable).insert([sanitizedRecord]).select();
    if (error) {
        console.error('❌ Failed to store FAQ in Supabase:', error.message);
    } else {
        console.log('💾 FAQ stored in Supabase', data?.[0]?.id || '');
    }
}

async function saveFeedbackRecord(record) {
    if (!supabase) {
        console.warn('⏭️  Skipping Supabase insert because client is not initialised.');
        return;
    }

    const sanitizedRecord = Object.entries(record).reduce((acc, [key, value]) => {
        if (value === undefined) {
            acc[key] = null;
        } else if (typeof value === 'string' && value.trim() === '') {
            acc[key] = null;
        } else {
            acc[key] = value;
        }
        return acc;
    }, {});

    const { data, error } = await supabase.from(feedbackTable).insert([sanitizedRecord]).select();
    if (error) {
        console.error('❌ Failed to store feedback in Supabase:', error.message);
    } else {
        console.log('💾 Feedback stored in Supabase', data?.[0]?.id || '');
    }
}

function buildChipsPayload(options) {
    return {
        "payload": {
            "richContent": [
                [{
                    "type": "chips",
                    "options": options
                }]
            ]
        }
    };
}

function buildMissingFieldsResponse(missing) {
    const text = `I still need your ${missing.join(' and ')}. Please provide the remaining detail(s) so I can log your request.`;
    return {
        "fulfillmentMessages": [{
            "text": { "text": [text] }
        }]
    };
}

// --- 4. WEBHOOK ROUTE ---
app.post('/dialogflow', async (request, response) => {
    try {
        console.log('👉 Request received!');

        const detectedIntent = request.body.queryResult.intent.displayName;
        const parameters = request.body.queryResult.parameters || {};
        const sessionId = request.body.session || request.body.sessionId || request.body.responseId;
        const channel = request.body.originalDetectIntentRequest?.source || 'dialogflow';
        const queryText = request.body.queryResult.queryText || '';
        const intentConfidence = request.body.queryResult.intentDetectionConfidence;
        const fallbackThreshold = parseFloat(process.env.FALLBACK_CONFIDENCE_THRESHOLD || '0.6');

        // Map chip labels (or quick replies) to server-side intents
        const chipIntentMap = {
            'customer support': 'Customer Support',
            'customer support help': 'Customer Support',
            'faq': 'FAQ',
            'frequently asked questions': 'FAQ',
            'feedback': 'Feedback',
            'leave feedback': 'Feedback'
        };

        let intentName = detectedIntent;
        const normalizedQuery = queryText.trim().toLowerCase();
        if (chipIntentMap[normalizedQuery]) {
            intentName = chipIntentMap[normalizedQuery];
            console.log(`🔁 Overriding intent based on chip selection: ${intentName}`);
        }

        // If the session is in the middle of an FAQ or Feedback flow,
        // force routing to that intent so we don't accidentally hit
        // Customer Support or other flows.
        const hasPendingFaqTop = faqPendingSessions.has(sessionId);
        const hasPendingFeedbackTop = feedbackPendingSessions.has(sessionId);

        if (hasPendingFaqTop && intentName !== 'FAQ') {
            console.log('🔁 Overriding intent to FAQ due to pending FAQ question');
            intentName = 'FAQ';
        } else if (hasPendingFeedbackTop && intentName !== 'Feedback') {
            console.log('🔁 Overriding intent to Feedback due to pending feedback');
            intentName = 'Feedback';
        }

        if (intentName === 'Default Welcome Intent') {
            console.log('✅ Manual Logic: Welcome Intent');

            const jsonResponse = {
                "fulfillmentMessages": [
                    {
                        "text": {
                            "text": [
                                "Welcome to Our Virtual Assistant. How can I help you today?"
                            ]
                        }
                    },
                    {
                        "text": {
                            "text": [
                                "Please select a category below to continue:"
                            ]
                        }
                    },
                    buildChipsPayload([
                        {
                        "text": "Customer Support",
                        "image": { "src": { "rawUrl": CHIP_IMAGES.support } }
                    },
                      {
                        "text": "FAQ",
                        "image": { "src": { "rawUrl": CHIP_IMAGES.faq } }
                    },
                    {
                        "text": "Feedback",
                        "image": { "src": { "rawUrl": CHIP_IMAGES.feedback } }
                    },
                    
                ])
                ]
            };
            return response.json(jsonResponse);
        } else if (intentName === 'Customer Support') {
            console.log('✅ Customer Support intent triggered');

            if (typeof intentConfidence === 'number' && intentConfidence < fallbackThreshold) {
                const fallbackText = await generateFallbackResponse(queryText || 'Hello');

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: intentName,
                    user_message: queryText,
                    channel,
                    response_text: fallbackText,
                    intent_confidence: intentConfidence,
                    used_gemini: true,
                    fallback_reason: 'low_confidence'
                });

                return response.json({
                    "fulfillmentText": fallbackText
                });
            }

            const userName = normalizeString(parameters.name);
            const userEmail = normalizeString(parameters.email);
            const userMessage = normalizeString(parameters.message || queryText);

            const missingFields = [];
            if (!userName) missingFields.push('name');
            if (!userEmail) missingFields.push('email');
            if (!userMessage) missingFields.push('message');

            if (missingFields.length > 0) {
                return response.json(buildMissingFieldsResponse(missingFields));
            }

            const replyText = `Thanks ${userName}! I have logged your request and our team will reach out at ${userEmail} very soon.`;

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_name: userName,
                user_email: userEmail,
                user_message: userMessage,
                channel,
                response_text: replyText,
                intent_confidence: intentConfidence,
                used_gemini: false,
                record_type: 'support'
            });

            return response.json({
                "fulfillmentMessages": [{
                    "text": {
                        "text": [
                            replyText
                        ]
                    }
                }]
            });
        } else if (intentName === 'FAQ') {
            console.log('✅ FAQ intent triggered');

            const normalizedFaqText = (queryText || '').trim().toLowerCase();
            const isFaqChipClick =
                normalizedFaqText === 'faq' ||
                normalizedFaqText === 'frequently asked questions';

            // Step 1: user clicked the FAQ chip -> ask them to type their question
            if (isFaqChipClick) {
                const promptText = 'Here are some frequently asked questions. You can tap one of them or type your own question.';

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

                return response.json({
                    "fulfillmentMessages": [
                        {
                            "text": {
                                "text": [
                                    promptText
                                ]
                            }
                        },
                        buildChipsPayload(
                            FAQ_PREDEFINED.map(item => ({
                                text: item.question
                            }))
                        )
                    ]
                });
            }

            // Step 2: user has typed an actual question -> answer with Gemini and store Q&A
            const userName = extractName(parameters);
            const userEmail = extractEmail(parameters);
            const faqQuestion = extractFaqTopic(parameters, queryText) || queryText;

            const normalizedFaqQuestion = (faqQuestion || '').trim().toLowerCase();
            const predefinedAnswer = FAQ_ANSWER_MAP[normalizedFaqQuestion];

            let faqAnswer;
            let usedGeminiForFaq = false;

            if (predefinedAnswer) {
                faqAnswer = predefinedAnswer;
            } else {
                const geminiPrompt = `The user is asking an FAQ about our products or services.\n\nQuestion: "${faqQuestion}"\n\nProvide a clear, concise answer in simple language.`;
                faqAnswer = await generateFallbackResponse(geminiPrompt);
                usedGeminiForFaq = true;
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
                used_gemini: usedGeminiForFaq
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
                used_gemini: usedGeminiForFaq
            });

            return response.json({
                "fulfillmentMessages": [{
                    "text": {
                        "text": [
                            faqAnswer
                        ]
                    }
                }]
            });
        } else if (intentName === 'Feedback') {
            console.log('✅ Feedback intent triggered');

            const normalizedFeedbackText = (queryText || '').trim().toLowerCase();
            const isFeedbackChipClick =
                normalizedFeedbackText === 'feedback' ||
                normalizedFeedbackText === 'leave feedback';

            // Step 1: user clicked the Feedback chip -> ask them to type their feedback
            if (isFeedbackChipClick) {
                const promptText = 'Please type your feedback and I will share it with our team.';

                feedbackPendingSessions.add(sessionId);

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: intentName,
                    user_message: queryText,
                    channel,
                    response_text: promptText,
                    record_type: 'feedback_start',
                    intent_confidence: intentConfidence,
                    used_gemini: false
                });

                return response.json({
                    "fulfillmentMessages": [{
                        "text": {
                            "text": [
                                promptText
                            ]
                        }
                    }]
                });
            }

            // Step 2: user has typed actual feedback -> store and thank them
            const userName = extractName(parameters);
            const userEmail = extractEmail(parameters);
            const feedbackText = extractUserMessage(parameters, queryText);
            const feedbackRating = extractRating(parameters);
            const replyText = 'Thanks for your feedback. It really helps us improve our service.';

            feedbackPendingSessions.delete(sessionId);

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_name: userName,
                user_email: userEmail,
                user_message: feedbackText,
                channel,
                response_text: replyText,
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

            return response.json({
                "fulfillmentMessages": [{
                    "text": {
                        "text": [
                            replyText
                        ]
                    }
                }]
            });
        } else {
            const hasPendingFaq = faqPendingSessions.has(sessionId);
            const hasPendingFeedback = feedbackPendingSessions.has(sessionId);

            if (hasPendingFaq) {
                console.log('ℹ️ FAQ follow-up detected in fallback handler');

                const faqQuestion = queryText || '';
                const normalizedFaqQuestion = faqQuestion.trim().toLowerCase();
                const predefinedAnswer = FAQ_ANSWER_MAP[normalizedFaqQuestion];

                let faqAnswer;
                let usedGeminiForFaq = false;

                if (predefinedAnswer) {
                    faqAnswer = predefinedAnswer;
                } else {
                    const geminiPrompt = `The user is asking an FAQ about our products or services.\n\nQuestion: "${faqQuestion}"\n\nProvide a clear, concise answer in simple language.`;
                    faqAnswer = await generateFallbackResponse(geminiPrompt);
                    usedGeminiForFaq = true;
                }

                faqPendingSessions.delete(sessionId);

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: 'FAQ',
                    user_name: extractName(parameters),
                    user_email: extractEmail(parameters),
                    user_message: faqQuestion,
                    channel,
                    response_text: faqAnswer,
                    record_type: 'faq',
                    intent_confidence: intentConfidence,
                    used_gemini: usedGeminiForFaq,
                    fallback_reason: usedGeminiForFaq ? 'faq_followup' : 'faq_followup_predefined'
                });

                await saveFaqRecord({
                    session_id: sessionId,
                    user_name: extractName(parameters),
                    user_email: extractEmail(parameters),
                    question_text: faqQuestion,
                    answer_text: faqAnswer,
                    channel,
                    intent_name: 'FAQ',
                    intent_confidence: intentConfidence,
                    used_gemini: usedGeminiForFaq
                });

                return response.json({
                    "fulfillmentMessages": [{
                        "text": {
                            "text": [
                                faqAnswer
                            ]
                        }
                    }]
                });
            }

            if (hasPendingFeedback) {
                console.log('ℹ️ Feedback follow-up detected in fallback handler');

                const userName = extractName(parameters);
                const userEmail = extractEmail(parameters);
                const feedbackText = extractUserMessage(parameters, queryText);
                const feedbackRating = extractRating(parameters);
                const replyText = 'Thanks for your feedback. It really helps us improve our service.';

                feedbackPendingSessions.delete(sessionId);

                await saveConversationRecord({
                    session_id: sessionId,
                    intent_name: 'Feedback',
                    user_name: userName,
                    user_email: userEmail,
                    user_message: feedbackText,
                    channel,
                    response_text: replyText,
                    feedback_rating: feedbackRating,
                    record_type: 'feedback',
                    intent_confidence: intentConfidence,
                    used_gemini: false,
                    fallback_reason: 'feedback_followup'
                });

                await saveFeedbackRecord({
                    session_id: sessionId,
                    user_name: userName,
                    user_email: userEmail,
                    feedback_text: feedbackText,
                    feedback_rating: feedbackRating,
                    channel,
                    intent_name: 'Feedback',
                    intent_confidence: intentConfidence,
                    used_gemini: false
                });

                return response.json({
                    "fulfillmentMessages": [{
                        "text": {
                            "text": [
                                replyText
                            ]
                        }
                    }]
                });
            }

            console.log('⚙️  Fallback handler hit');
            const fallbackText = await generateFallbackResponse(queryText || 'Hello');

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_message: queryText,
                channel,
                response_text: fallbackText,
                intent_confidence: intentConfidence,
                used_gemini: true,
                fallback_reason: 'unknown_intent'
            });

            return response.json({
                "fulfillmentText": fallbackText
            });
        }
    } catch (error) {
        console.error('❌ Error handling Dialogflow request:', error);
        return response.json({
            "fulfillmentText": "Something went wrong while processing your request. Please try again."
        });
    }
});

app.listen(port, () => {
    console.log(`Saylani Bot is running locally on port ${port}`);
});
