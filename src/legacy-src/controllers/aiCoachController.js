const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const mongoose = require('mongoose');
const AICoachInteraction = require('../models/AICoachInteraction');
const { 
  getCachedResponse, 
  setCachedResponse, 
  shouldCache,
  getCacheStats 
} = require('../utils/responseCache');
const { validateMessage, sanitizeInput } = require('../utils/sanitize');
const { getTopicInstructions } = require('../utils/topicPrompts');
const { getUserPreferences, getPersonalizedInstructions } = require('../utils/userPreferences');
const { uploadImage, uploadVideo } = require('../utils/cloudinary');
const { retrieveKnowledge, formatKnowledgeContext } = require('../utils/knowledgeRetrieval');
const { getWebSearchResults, formatSearchResults, shouldSearchWeb } = require('../utils/webSearch');
const log = require('../utils/logger');

// Initialize all AI services
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// AI Configuration
const AI_CONFIG = {
  gemini: {
    name: 'Gemini',
    priority: 1,
    bestFor: ['multilingual', 'gaming', 'general'],
    cost: 'free',
    rateLimit: 15 // requests per minute
  },
  llama: {
    name: 'Llama 3.1',
    priority: 2,
    bestFor: ['gaming', 'strategies', 'general'],
    cost: 'free', // Groq free tier
    rateLimit: 30 // requests per minute
  },
  // chatgpt: {
  //   name: 'ChatGPT',
  //   priority: 2,
  //   bestFor: ['creative', 'complex', 'strategies'],
  //   cost: 'paid',
  //   rateLimit: 3
  // },
  // deepseek: {
  //   name: 'DeepSeek',
  //   priority: 3,
  //   bestFor: ['technical', 'coding', 'analytics'],
  //   cost: 'paid',
  //   rateLimit: 5
  // },
  // grok: {
  //   name: 'Grok',
  //   priority: 4,
  //   bestFor: ['realtime', 'current_events', 'news'],
  //   cost: 'paid',
  //   rateLimit: 10
  // },
  // perplexity: {
  //   name: 'Perplexity',
  //   priority: 5,
  //   bestFor: ['research', 'facts', 'detailed_info'],
  //   cost: 'paid',
  //   rateLimit: 8
  // }
};

// AI Selection Logic - Smart selection based on query
const selectBestAI = (message, language, context = {}) => {
  // For Hindi/Roman Hindi - use Gemini (best multilingual support)
  if (language === 'roman_hindi' || language === 'devanagari_hindi' || language === 'roman_marathi' || language === 'devanagari_marathi') {
    return 'gemini';
  }
  
  // For English and Mixed (English + some Hindi words) - use Llama (faster, good quality)
  // Mixed usually means mostly English with some Hindi words, which Llama can handle
  if (language === 'english' || language === 'mixed') {
    // Check if message is mostly English (more than 70% English characters)
    const englishChars = (message.match(/[a-zA-Z]/g) || []).length;
    const totalChars = message.replace(/\s/g, '').length;
    const englishPercentage = totalChars > 0 ? (englishChars / totalChars) * 100 : 0;
    
    // If mostly English, use Llama (faster and good quality)
    if (englishPercentage >= 70) {
      return 'llama';
    }
    
    // If less English, use Gemini (better multilingual)
    return 'gemini';
  }
  
  // Default to Gemini for safety
  return 'gemini';
};

// Gemini API Call with Enhanced Error Handling and Knowledge Base Integration
const callGemini = async (message, conversationHistory = [], detectedLanguage = 'english', userPreferences = null, knowledgeContext = '', webSearchContext = '') => {
  try {
    // Validate input
    if (!message || message.trim().length === 0) {
      throw new Error('Message cannot be empty');
    }

    // Check if API key is available
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Gemini API key not configured');
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    // Create language-specific system prompt
    let languageInstruction = '';
    
    switch (detectedLanguage) {
      case 'devanagari_hindi':
        languageInstruction = `
CRITICAL LANGUAGE RULE:
- User wrote in Hindi using Devanagari script (like कैसे, क्या, है)
- You MUST respond ONLY in Hindi using Devanagari script
- Use proper Hindi grammar and vocabulary
- Do NOT use English words or Roman script
- Example: "आपका एम कैसे सुधारें" instead of "aim kaise improve kare"`;
        break;
        
      case 'roman_hindi':
        languageInstruction = `
CRITICAL LANGUAGE RULE - STRICT SCRIPT MATCHING:
- User wrote in Roman Hindi/Hinglish using English alphabet (like kaise, kya, hai)
- You MUST respond ONLY in Roman Hindi/Hinglish using English alphabet
- NEVER use Devanagari script (कैसे, क्या, है) - ONLY use Roman script
- NEVER use Bengali script (কেমন, কি, আছে) - ONLY use Roman script
- Mix Hindi and English naturally using Roman script
- Example: "kesa hai bhai" should get "sab theek hai bhai" NOT "সব ঠিক আছে ভাই"
- Use ONLY English alphabet: a-z, A-Z, numbers, and basic punctuation`;
        break;
        
      case 'devanagari_marathi':
        languageInstruction = `
CRITICAL LANGUAGE RULE:
- User wrote in Marathi using Devanagari script (like कसे, काय, आहे)
- You MUST respond ONLY in Marathi using Devanagari script
- Use proper Marathi grammar and vocabulary
- Do NOT use Hindi, English, or Roman script
- Example: "तुमचा एम कसा सुधारायचा" instead of "aim kashe improve karaycha"`;
        break;
        
      case 'roman_marathi':
        languageInstruction = `
CRITICAL LANGUAGE RULE - STRICT SCRIPT MATCHING:
- User wrote in Roman Marathi using English alphabet (like kase, kay, ahe)
- You MUST respond ONLY in Roman Marathi using English alphabet
- NEVER use Devanagari script (कसे, काय, आहे) - ONLY use Roman script
- NEVER use Bengali script (কেমন, কি, আছে) - ONLY use Roman script
- Use Roman script for Marathi words (kase, kay, ahe, etc.)
- Example: "tumcha aim kasa sudharaycha"
- Use ONLY English alphabet: a-z, A-Z, numbers, and basic punctuation`;
        break;

      case 'mixed':
        languageInstruction = `
CRITICAL LANGUAGE RULE:
- User wrote in mixed language (combination of English and Indian language)
- Respond in the SAME style they used
- Match their language mixing pattern
- Be natural and conversational`;
        break;
        
      default:
        languageInstruction = `
CRITICAL LANGUAGE RULE:
- User wrote in English
- You MUST respond in English
- Be natural and conversational in English`;
    }
    
    // Determine topic for topic-specific instructions
    const topic = message.toLowerCase().includes('aim') ? 'aim' :
                 message.toLowerCase().includes('rank') ? 'rank' :
                 message.toLowerCase().includes('warmup') ? 'warmup' :
                 message.toLowerCase().includes('communication') ? 'communication' :
                 message.toLowerCase().includes('valorant') ? 'valorant' :
                 message.toLowerCase().includes('csgo') || message.toLowerCase().includes('cs2') ? 'csgo' :
                 'general';
    
    // Get topic-specific instructions
    const topicInstructions = getTopicInstructions(topic, detectedLanguage);
    
    // Get personalized instructions based on user preferences
    const personalizedInstructions = userPreferences ? getPersonalizedInstructions(userPreferences) : '';
    
    let systemPrompt = `You are an expert AI Gaming Coach. You help gamers improve their skills, strategies, and performance across various games like BGMI, Valorant, CS:GO, Free Fire, Call of Duty Mobile, Fortnite, Apex Legends, etc.

Your personality:
- Enthusiastic and encouraging
- Knowledgeable about gaming strategies and esports
- Supportive and constructive
- Use gaming terminology naturally
- Provide actionable advice
- Be conversational and friendly
- Focus on practical tips for improvement

${languageInstruction}

${topicInstructions}

${personalizedInstructions}

ABSOLUTE RULE: Match the EXACT script the user used. If they used Roman script (English alphabet), respond in Roman script. If they used Devanagari script, respond in Devanagari script. NEVER mix scripts.

EXAMPLES:
- User: "kesa hai bhai" (Roman script) → Response: "sab theek hai bhai! kya help chahiye?" (Roman script)
- User: "कैसे है भाई" (Devanagari script) → Response: "सब ठीक है भाई! क्या मदद चाहिए?" (Devanagari script)
- User: "kase ahe bhai" (Roman Marathi) → Response: "sagla theek ahe bhai! kay madad pahije?" (Roman Marathi)

CRITICAL RESPONSE RULES:
1. If user asks a specific question, ANSWER IT DIRECTLY first
2. DO NOT ask irrelevant follow-up questions before answering
3. DO NOT suggest other topics unless user asks
4. If web search results are provided, USE THEM to answer the question
5. Focus on what user asked, not what you want to discuss

Response Format Guidelines:
- Keep responses clean and professional
- Use bullet points with simple dashes (-) for lists
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆🗣️📢⚡💡🚀)
- Keep responses detailed but concise (200-400 words)
- Answer the user's question FIRST, then optionally ask relevant follow-ups
- NEVER use markdown formatting like **bold** or *italic* - these will show as raw text
- If you need to emphasize something, just write it normally without special formatting
- Provide specific, actionable tips`;

    let conversationContext = '';
    if (conversationHistory.length > 0) {
      conversationContext = '\n\nPrevious conversation:\n';
      conversationHistory.slice(-5).forEach(msg => {
        conversationContext += `${msg.role === 'user' ? 'User' : 'AI'}: ${msg.content}\n`;
      });
    }

    // Add knowledge context from knowledge base (RAG - Retrieval Augmented Generation)
    // This makes the AI independent by using your own knowledge
    const fullPrompt = `${systemPrompt}${knowledgeContext}${webSearchContext || ''}${conversationContext}\n\nUser's current message: ${message.trim()}`;
    
    // Set timeout for API call
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Gemini API timeout after 30 seconds')), 30000);
    });

    const apiCallPromise = model.generateContent(fullPrompt);
    
    const result = await Promise.race([apiCallPromise, timeoutPromise]);
    const responseText = result.response.text();
    
    // Validate response
    if (!responseText || responseText.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    return responseText;
  } catch (error) {
    log.error('Gemini API Error:', { error: String(error) });
    
    // Enhanced error logging
    if (error.message?.includes('quota')) {
      log.error('Gemini API quota exceeded');
      throw new Error('API quota exceeded. Please try again later.');
    } else if (error.message?.includes('timeout')) {
      log.error('Gemini API timeout');
      throw new Error('Request timeout. Please try again.');
    } else if (error.message?.includes('API key')) {
      log.error('Gemini API key issue');
      throw new Error('API configuration error');
    }
    
    throw error;
  }
};

// ChatGPT API Call
const callChatGPT = async (message, conversationHistory = []) => {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are an expert AI Gaming Coach. You help gamers improve their skills, strategies, and performance across various games like Valorant, CS:GO, Fortnite, Apex Legends, etc.

Your personality:
- Enthusiastic and encouraging
- Knowledgeable about gaming strategies
- Supportive and constructive
- Use gaming terminology naturally
- Provide actionable advice
- Be conversational and friendly

IMPORTANT: Respond in the SAME language as the user's message. If they write in Roman Hindi/Hinglish, respond in Roman Hindi/Hinglish. If they write in English, respond in English. If they write in Hindi (Devanagari), respond in Hindi.

Always format your responses with:
- Use **bold** for important points
- Use bullet points (•) for lists
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆🗣️📢⚡💡🚀)
- Keep responses detailed but not overwhelming
- Ask follow-up questions to engage the user`
        },
        ...conversationHistory.slice(-10).map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    log.error('ChatGPT API Error:', { error: String(error) });
    if (error.response?.status === 429) {
      log.error('ChatGPT Rate Limit Exceeded');
    }
    throw error;
  }
};

// DeepSeek API Call
const callDeepSeek = async (message, conversationHistory = []) => {
  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `You are an expert AI Gaming Coach specializing in technical gaming advice, performance optimization, and advanced strategies. You help gamers improve their skills, strategies, and performance across various games like Valorant, CS:GO, Fortnite, Apex Legends, etc.

Your personality:
- Technical and analytical
- Knowledgeable about gaming mechanics
- Focus on performance optimization
- Provide detailed technical advice
- Be precise and data-driven

IMPORTANT: Respond in the SAME language as the user's message. If they write in Roman Hindi/Hinglish, respond in Roman Hindi/Hinglish. If they write in English, respond in English. If they write in Hindi (Devanagari), respond in Hindi.

Always format your responses with:
- Use **bold** for important points
- Use bullet points (•) for lists
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆🗣️📢⚡💡🚀)
- Keep responses detailed but not overwhelming
- Ask follow-up questions to engage the user`
        },
        ...conversationHistory.slice(-10).map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    log.error('DeepSeek API Error:', { error: String(error) });
    if (error.response?.status === 429) {
      log.error('DeepSeek Rate Limit Exceeded');
    }
    throw error;
  }
};

// Grok API Call
const callGrok = async (message, conversationHistory = []) => {
  try {
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-beta',
      messages: [
        {
          role: 'system',
          content: `You are an expert AI Gaming Coach with access to real-time information. You help gamers improve their skills, strategies, and performance across various games like Valorant, CS:GO, Fortnite, Apex Legends, etc.

Your personality:
- Enthusiastic and encouraging
- Knowledgeable about gaming strategies
- Supportive and constructive
- Use gaming terminology naturally
- Provide actionable advice
- Be conversational and friendly
- Access to real-time gaming news and updates

IMPORTANT: Respond in the SAME language as the user's message. If they write in Roman Hindi/Hinglish, respond in Roman Hindi/Hinglish. If they write in English, respond in English. If they write in Hindi (Devanagari), respond in Hindi.

Always format your responses with:
- Use **bold** for important points
- Use bullet points (•) for lists
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆🗣️📢⚡💡🚀)
- Keep responses detailed but not overwhelming
- Ask follow-up questions to engage the user`
        },
        ...conversationHistory.slice(-10).map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    log.error('Grok API Error:', { error: String(error) });
    if (error.response?.status === 429) {
      log.error('Grok Rate Limit Exceeded');
    }
    throw error;
  }
};

// Perplexity API Call
const callPerplexity = async (message, conversationHistory = []) => {
  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-medium',
      messages: [
        {
          role: 'system',
          content: `You are an expert AI Gaming Coach with access to real-time information and research capabilities. You help gamers improve their skills, strategies, and performance across various games like Valorant, CS:GO, Fortnite, Apex Legends, etc.

Your personality:
- Research-oriented and fact-based
- Knowledgeable about gaming strategies
- Supportive and constructive
- Use gaming terminology naturally
- Provide detailed, well-researched advice
- Be conversational and friendly
- Access to real-time gaming information and research

IMPORTANT: Respond in the SAME language as the user's message. If they write in Roman Hindi/Hinglish, respond in Roman Hindi/Hinglish. If they write in English, respond in English. If they write in Hindi (Devanagari), respond in Hindi.

Always format your responses with:
- Use **bold** for important points
- Use bullet points (•) for lists
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆🗣️📢⚡💡🚀)
- Keep responses detailed but not overwhelming
- Ask follow-up questions to engage the user
- Provide sources when relevant`
        },
        ...conversationHistory.slice(-10).map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    log.error('Perplexity API Error:', { error: String(error) });
    if (error.response?.status === 429) {
      log.error('Perplexity Rate Limit Exceeded');
    } else if (error.response?.status === 401) {
      log.error('Perplexity API Key Invalid');
    }
    console.error('Perplexity API Response:', error.response?.data);
    throw error;
  }
};

// Llama API Call via Groq (Independent AI with Knowledge Base)
const callLlama = async (message, conversationHistory = [], detectedLanguage = 'english', userPreferences = null, knowledgeContext = '', webSearchContext = '') => {
  try {
    // Validate input
    if (!message || message.trim().length === 0) {
      throw new Error('Message cannot be empty');
    }

    // Check if API key is available
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Groq API key not configured. Get it from https://console.groq.com');
    }

    // Create language-specific instruction
    let languageInstruction = '';
    switch (detectedLanguage) {
      case 'roman_hindi':
        languageInstruction = 'IMPORTANT: User wrote in Roman Hindi/Hinglish. Respond ONLY in Roman Hindi/Hinglish using English alphabet.';
        break;
      case 'devanagari_hindi':
        languageInstruction = 'IMPORTANT: User wrote in Hindi (Devanagari). Respond ONLY in Hindi using Devanagari script.';
        break;
      case 'roman_marathi':
        languageInstruction = 'IMPORTANT: User wrote in Roman Marathi. Respond ONLY in Roman Marathi using English alphabet.';
        break;
      default:
        languageInstruction = 'IMPORTANT: Respond in English.';
    }

    // Create system prompt with knowledge context
    let systemPrompt = `You are an expert AI Gaming Coach. You help gamers improve their skills, strategies, and performance across various games like BGMI, Valorant, CS:GO, Free Fire, Call of Duty Mobile, etc.

Your personality:
- Enthusiastic and encouraging
- Knowledgeable about gaming strategies and esports
- Supportive and constructive
- Use gaming terminology naturally
- Provide actionable advice
- Be conversational and friendly

${languageInstruction}

${knowledgeContext ? `\n\nRELEVANT GAMING KNOWLEDGE FROM DATABASE:\n${knowledgeContext}\n\nUse this knowledge to provide accurate and helpful responses.` : ''}

${webSearchContext ? webSearchContext : ''}

CRITICAL RESPONSE RULES:
1. If user asks a specific question, ANSWER IT DIRECTLY first
2. DO NOT ask irrelevant follow-up questions before answering
3. DO NOT suggest other topics unless user asks
4. If web search results are provided, USE THEM to answer the question
5. Focus on what user asked, not what you want to discuss

Response Format:
- Use bullet points with dashes (-) for lists
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆)
- Keep responses detailed but concise (200-400 words)
- Answer the user's question FIRST, then optionally ask relevant follow-ups
- Provide specific, actionable tips`;

    // Prepare messages
    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...conversationHistory.slice(-10).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      })),
      {
        role: 'user',
        content: message.trim()
      }
    ];

    // Call Groq API (Llama 3.1 - Fast and reliable)
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant', // Fast and reliable (always available)
      // Alternative models: 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768'
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 seconds timeout
    });

    const responseText = response.data.choices[0]?.message?.content;

    if (!responseText || responseText.trim().length === 0) {
      throw new Error('Empty response from Llama API');
    }

    return responseText;
  } catch (error) {
    log.error('Llama API Error:', { error: String(error) });
    
    // Enhanced error logging
    if (error.response?.status === 429) {
      log.error('Groq API rate limit exceeded');
      throw new Error('Rate limit exceeded. Please try again later.');
    } else if (error.response?.status === 401) {
      log.error('Groq API key invalid');
      throw new Error('API key invalid. Please check your Groq API key.');
    } else if (error.message?.includes('timeout')) {
      log.error('Llama API timeout');
      throw new Error('Request timeout. Please try again.');
    }
    
    throw error;
  }
};

// Main AI Call Function
const callAI = async (aiType, message, conversationHistory = [], detectedLanguage = 'english', userPreferences = null, knowledgeContext = '', webSearchContext = '') => {
  const startTime = Date.now();
  
  try {
    let response;
    
    switch (aiType) {
      case 'gemini':
        response = await callGemini(message, conversationHistory, detectedLanguage, userPreferences, knowledgeContext, webSearchContext);
        break;
      case 'llama':
        response = await callLlama(message, conversationHistory, detectedLanguage, userPreferences, knowledgeContext, webSearchContext);
        break;
      // case 'chatgpt':
      //   response = await callChatGPT(message, conversationHistory);
      //   break;
      // case 'deepseek':
      //   response = await callDeepSeek(message, conversationHistory);
      //   break;
      // case 'grok':
      //   response = await callGrok(message, conversationHistory);
      //   break;
      // case 'perplexity':
      //   response = await callPerplexity(message, conversationHistory);
      //   break;
      default:
        throw new Error(`Unknown AI type: ${aiType}`);
    }
    
    const responseTime = Date.now() - startTime;
    
    return {
      response,
      responseTime,
      aiType,
      success: true
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    return {
      response: null,
      responseTime,
      aiType,
      success: false,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    };
  }
};

// Enhanced Language Detection with Better Accuracy
const detectLanguage = (message) => {
  const lowerMessage = message.toLowerCase();
  const trimmedMessage = message.trim();
  
  // Devanagari Script Detection (Hindi, Marathi, Sanskrit, etc.)
  const devanagariPattern = /[\u0900-\u097F]/;
  const hasDevanagari = devanagariPattern.test(message);
  
  // Calculate percentage of Devanagari characters
  const devanagariChars = (message.match(/[\u0900-\u097F]/g) || []).length;
  const totalChars = message.replace(/\s/g, '').length;
  const devanagariPercentage = totalChars > 0 ? (devanagariChars / totalChars) * 100 : 0;
  
  // Roman Hindi/Hinglish Patterns (more comprehensive)
  const romanHindiPatterns = [
    /\b(kaise|kya|kab|kahan|kyun|kisne|kisko|kiske|kis|kaun|kaunsi|kaunsa)\b/i,
    /\b(mera|meri|mere|hamara|hamari|hamare|tumhara|tumhari|tumhare|tera|teri|tere)\b/i,
    /\b(hai|hain|tha|thi|the|ho|hoo|hoon|hun|hu|hoge|hogi)\b/i,
    /\b(mein|main|tum|tu|aap|ham|hum|wo|woh|usne|usko|uska|iska|yeh|ye)\b/i,
    /\b(achha|accha|theek|thik|sahi|galat|bura|buraa|badiya|badhiya)\b/i,
    /\b(khel|khelna|khelte|khelta|khelti|game|gaming|gameplay)\b/i,
    /\b(bhai|bro|dost|yaar|arre|are|bhava)\b/i,
    /\b(karo|karna|karke|karte|karunga|karungi|kar|karta|karti)\b/i,
    /\b(batao|bata|bolo|bol|dekho|dekh|suno|sun)\b/i,
    /\b(nahi|nai|nahin|haan|ha|haa|bilkul|thoda|bahut)\b/i
  ];
  
  // Roman Marathi Patterns (more comprehensive)
  const romanMarathiPatterns = [
    /\b(kase|kasa|kashi|kay|kuthun|kuthe|kun|kuni|kasala|kasathi)\b/i,
    /\b(maza|mazya|mazhi|maze|tuzha|tuzhi|tuzhya|tuze|amcha|amchi|amche)\b/i,
    /\b(ahe|aahe|ahet|aahet|hot|hota|hoti|hote|ho|aho)\b/i,
    /\b(me|mi|tu|tumhi|amhi|to|ti|tyane|tyala|tyacha|tyachi)\b/i,
    /\b(bar|bari|thik|sahi|chuk|chuki|vaay|vait|bhari|bharicha)\b/i,
    /\b(khel|khelna|khelto|khelte|game|gaming)\b/i,
    /\b(bhai|bhau|dada|tai|aho|aga|re)\b/i,
    /\b(kar|kara|karu|karaycha|kartos|kartes|karte|karun)\b/i,
    /\b(sang|sanga|sangto|bola|bol|boltos|bolte)\b/i,
    /\b(nahi|nai|hoy|hoyi|thoda|jar|pudhe|mage)\b/i
  ];
  
  // Count pattern matches
  const romanHindiMatches = romanHindiPatterns.filter(pattern => pattern.test(lowerMessage)).length;
  const romanMarathiMatches = romanMarathiPatterns.filter(pattern => pattern.test(lowerMessage)).length;
  
  // If message contains Devanagari script (>30% Devanagari characters)
  if (hasDevanagari && devanagariPercentage > 30) {
    // Check if it's Marathi (has Marathi-specific characters or patterns)
    const marathiPatterns = [
      /[\u0902\u0903\u0905-\u0914\u0950]/,  // Marathi-specific characters
      /\b(कसे|कसा|कशी|काय|कुठे|कुणी|कशाला|कसाठी)\b/,
      /\b(माझा|माझी|माझे|तुझा|तुझी|तुझे|तुझ्या|आमचा|आमची|आमचे|आमच्या)\b/,
      /\b(आहे|आहेत|होत|होता|होती|होते|हो|आहो)\b/,
      /\b(मी|तू|तुम्ही|आम्ही|तो|ती|त्याने|त्याला|त्याचा|त्याची)\b/,
      /\b(बर|बरं|ठीक|सही|चूक|वाईट|भारी|भारीच)\b/,
      /\b(कर|करा|करू|करायचा|करतोस|करतेस|करते|करून)\b/,
      /\b(सांग|सांगा|सांगतो|बोल|बोला|बोलतोस|बोलते)\b/
    ];
    
    const marathiMatches = marathiPatterns.filter(pattern => pattern.test(message)).length;
    
    if (marathiMatches >= 2) {
      return 'devanagari_marathi';
    } else {
      return 'devanagari_hindi';
    }
  }
  
  // Roman script detection - Marathi has priority if both match
  if (romanMarathiMatches >= 2 && romanMarathiMatches > romanHindiMatches) {
    return 'roman_marathi';
  }
  
  if (romanHindiMatches >= 2) {
    return 'roman_hindi';
  }
  
  // Check for pure English (only English letters, spaces, and punctuation)
  if (/^[a-zA-Z\s.,!?'"-]+$/.test(trimmedMessage) && romanHindiMatches === 0 && romanMarathiMatches === 0) {
    return 'english';
  }
  
  // Mixed language (Hinglish/Marglish or multiple scripts)
  return 'mixed';
};

// Topic Detection
const determineTopic = (message) => {
  const lowerMessage = message.toLowerCase();
  
  if (lowerMessage.includes('aim') || lowerMessage.includes('aiming') || lowerMessage.includes('flick') || lowerMessage.includes('headshot')) {
    return 'aim';
  }
  if (lowerMessage.includes('valorant') || lowerMessage.includes('valo')) {
    return 'valorant';
  }
  if (lowerMessage.includes('csgo') || lowerMessage.includes('counter strike') || lowerMessage.includes('cs2')) {
    return 'csgo';
  }
  if (lowerMessage.includes('rank') || lowerMessage.includes('ranking') || lowerMessage.includes('rankup')) {
    return 'rank';
  }
  if (lowerMessage.includes('communication') || lowerMessage.includes('callout') || lowerMessage.includes('team')) {
    return 'communication';
  }
  if (lowerMessage.includes('warmup') || lowerMessage.includes('practice') || lowerMessage.includes('training')) {
    return 'warmup';
  }
  
  return 'general';
};

// Main Chat Function with Enhanced Error Handling
const chatWithAI = async (req, res) => {
  let conversationId = null;
  let detectedLanguage = 'english';
  
  try {
    const { message, conversationHistory = [], preferredAI = null, useCache = true } = req.body;
    const userId = req.user?.id;

    // Validate and sanitize input
    const validation = validateMessage(message);
    
    if (!validation.valid) {
      console.warn(`⚠️ Invalid message from user ${userId}: ${validation.error}`);
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Use sanitized message for processing
    const sanitizedMessage = validation.sanitized;

    // Auto-detect rotation/zone generation requests and bypass cache
    const isRotationRequest = sanitizedMessage.toLowerCase().includes('zone') || 
                             sanitizedMessage.toLowerCase().includes('z1') || 
                             sanitizedMessage.toLowerCase().includes('z2') || 
                             sanitizedMessage.toLowerCase().includes('z3') ||
                             sanitizedMessage.toLowerCase().includes('rotation') ||
                             sanitizedMessage.includes('BGMI') ||
                             sanitizedMessage.includes('waypoints') ||
                             sanitizedMessage.includes('holdingSpots');

    const shouldUseCache = useCache && !isRotationRequest;

    detectedLanguage = detectLanguage(sanitizedMessage);
    const topic = determineTopic(sanitizedMessage);
    
    // Get user preferences for personalized responses
    const userPreferences = await getUserPreferences(userId);
    if (process.env.NODE_ENV === 'development') { console.log(`📊 User preferences loaded - Skill: ${userPreferences.skillLevel}, Topics: ${userPreferences.favoriteTopics.join(', ')}`);
    }
    // Retrieve relevant knowledge from knowledge base (RAG - Retrieval Augmented Generation)
    let knowledgeContext = '';
    try {
      // Detect game from message
      const game = sanitizedMessage.toLowerCase().includes('bgmi') ? 'bgmi' :
                   sanitizedMessage.toLowerCase().includes('valorant') ? 'valorant' :
                   sanitizedMessage.toLowerCase().includes('csgo') || sanitizedMessage.toLowerCase().includes('cs2') ? 'csgo' :
                   sanitizedMessage.toLowerCase().includes('freefire') ? 'freefire' :
                   sanitizedMessage.toLowerCase().includes('codm') ? 'codm' :
                   'general';
      
      const knowledgeItems = await retrieveKnowledge(sanitizedMessage, detectedLanguage, topic, game, 3);
      
      if (knowledgeItems && knowledgeItems.length > 0) {
        knowledgeContext = formatKnowledgeContext(knowledgeItems, detectedLanguage);
        if (process.env.NODE_ENV === 'development') { console.log(`📚 Retrieved ${knowledgeItems.length} knowledge items from database`);}
      } else {
        if (process.env.NODE_ENV === 'development') { console.log('📚 No relevant knowledge found in database');}
      }
    } catch (knowledgeError) {
      console.error('⚠️ Knowledge retrieval error (continuing without knowledge):', knowledgeError.message);
      // Continue without knowledge if retrieval fails
    }
    
    // Liquipedia integration removed
    let liquipediaContext = '';

    // Web Search for real-time information (if needed)
    let webSearchContext = '';
    let webSearchStatus = null;
    try {
      if (shouldSearchWeb(sanitizedMessage)) {
        if (process.env.NODE_ENV === 'development') { console.log('🔍 Query needs real-time info, searching web...');}
        const searchData = await getWebSearchResults(sanitizedMessage);
        
        if (searchData && searchData.results && searchData.results.length > 0) {
          webSearchContext = formatSearchResults(searchData.results);
          webSearchStatus = {
            searching: false,
            found: true,
            count: searchData.results.length,
            source: searchData.source || 'unknown'
          };
          if (process.env.NODE_ENV === 'development') { console.log(`🌐 Retrieved ${searchData.results.length} web search results from ${searchData.source}`);}
        } else {
          webSearchStatus = {
            searching: false,
            found: false,
            source: null
          };
        }
      }
    } catch (webSearchError) {
      console.error('⚠️ Web search error (continuing without web search):', webSearchError.message);
      webSearchStatus = {
        searching: false,
        found: false,
        error: webSearchError.message
      };
      // Continue without web search if it fails
    }
    
    // Check cache first for faster responses (only if shouldUseCache is true)
    let cachedResponse = null;
    if (shouldUseCache) {
      cachedResponse = getCachedResponse(sanitizedMessage, detectedLanguage);
      if (cachedResponse) {
        if (process.env.NODE_ENV === 'development') { console.log('✅ Cache HIT for language:', detectedLanguage);}
      }
    } else {
      if (process.env.NODE_ENV === 'development') { console.log('🔄 Cache bypassed - generating fresh response (rotation request or useCache=false)');}
    }
    
    if (cachedResponse) {
      if (process.env.NODE_ENV === 'development') { console.log('⚡ Using cached response - instant delivery!');
      }
      // Still save interaction for analytics
      conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        const interaction = new AICoachInteraction({
          userId,
          userMessage: sanitizedMessage.trim(),
          aiResponse: cachedResponse.response,
          topic,
          responseTime: 0, // Instant from cache
          conversationId,
          language: detectedLanguage,
          aiType: 'gemini'
        });
        await interaction.save();
      } catch (saveError) {
        log.error('Failed to save cached interaction:', { error: String(saveError) });
      }
      
      return res.json({
        success: true,
        data: {
          response: cachedResponse.response,
          timestamp: new Date().toISOString(),
          conversationId,
          topic,
          aiType: 'gemini',
          responseTime: 0,
          language: detectedLanguage,
          fromCache: true // Indicate it's from cache
        }
      });
    }
    
    // Select best AI - prioritize user preference
    let selectedAI;
    if (preferredAI && preferredAI !== 'auto') {
      selectedAI = preferredAI;
      if (process.env.NODE_ENV === 'development') { console.log(`AI Coach - Using preferred AI: ${selectedAI}`);}
    } else {
      selectedAI = selectBestAI(sanitizedMessage, detectedLanguage);
      if (process.env.NODE_ENV === 'development') { console.log(`AI Coach - Auto-selected AI: ${selectedAI}`);}
    }
    
    if (process.env.NODE_ENV === 'development') { console.log(`AI Coach - Preferred AI: ${preferredAI}, Selected AI: ${selectedAI}, Language: ${detectedLanguage}, Topic: ${topic}`);
}
      // Try primary AI first with user preferences, knowledge context, and Liquipedia data
      const fullContext = knowledgeContext + liquipediaContext + webSearchContext;
      let aiResult = await callAI(selectedAI, sanitizedMessage, conversationHistory, detectedLanguage, userPreferences, knowledgeContext, fullContext);
    
    // If primary AI fails, try fallback AIs (but respect user preference)
    if (!aiResult.success) {
      if (process.env.NODE_ENV === 'development') { console.log(`Primary AI ${selectedAI} failed, trying fallbacks...`);
      }
      // If user specifically requested an AI, try others but mark it as failed
      const fallbackAIs = Object.keys(AI_CONFIG).filter(ai => ai !== selectedAI);
      
      for (const fallbackAI of fallbackAIs) {
        if (process.env.NODE_ENV === 'development') { console.log(`Trying fallback AI: ${fallbackAI}`);}
        const fullContext = knowledgeContext + liquipediaContext + webSearchContext;
        const fallbackResult = await callAI(fallbackAI, sanitizedMessage, conversationHistory, detectedLanguage, userPreferences, knowledgeContext, fullContext);
        
        if (fallbackResult.success) {
          aiResult = fallbackResult;
          if (process.env.NODE_ENV === 'development') { console.log(`Fallback AI ${fallbackAI} succeeded`);}
          break;
        }
      }
      
      // If user specifically requested an AI and it failed, show error message
      if (!aiResult.success && preferredAI && preferredAI !== 'auto') {
        if (process.env.NODE_ENV === 'development') { console.log(`Preferred AI ${preferredAI} failed completely. Using fallback response.`);}
      }
    }

    // If all AIs fail, use fallback response
    if (!aiResult.success) {
      if (process.env.NODE_ENV === 'development') { console.log('All AIs failed, using fallback response');
      }
      let fallbackMessage;
      if (preferredAI && preferredAI !== 'auto') {
        // User specifically requested an AI that failed
        fallbackMessage = `Sorry, ${AI_CONFIG[preferredAI]?.name || preferredAI} is currently unavailable (rate limit or API error). I'm using Gemini instead to help you with your gaming question! 🎮`;
      } else {
        // General fallback - match user's language
        const fallbackResponses = {
          english: [
            "I'm having trouble connecting right now, but I'm here to help! Try asking me about aim training, game strategies, or ranking up tips. 🎯",
            "Sorry, I'm experiencing some technical difficulties. Feel free to ask me about gaming strategies, team communication, or practice routines! 🎮",
            "I'm temporarily unavailable, but I can still help with gaming advice! What specific aspect of gaming would you like to improve? 🚀"
          ],
          roman_hindi: [
            "Sorry bhai, thoda technical issue aa raha hai. Lekin main help karne ke liye ready hoon! Aim training, game strategies, ya rank up tips ke baare mein poocho. 🎯",
            "Kuch technical problem ho rahi hai, but don't worry! Gaming strategies, team communication, ya practice routine ke baare mein baat karte hain! 🎮"
          ],
          roman_marathi: [
            "Sorry bhau, thoda technical issue ahe. Pan mi help karto! Aim training, game strategies, kiva rank up tips baddal vicharun ghya. 🎯",
            "Kahi technical problem ahe, pan chinta nahi! Gaming strategies, team communication, kiva practice routine baddal bolaycha? 🎮"
          ],
          mixed: [
            "I'm having trouble connecting right now, but I'm here to help! Try asking me about aim training, game strategies, or ranking up tips. 🎯"
          ]
        };
        
        const languageFallbacks = fallbackResponses[detectedLanguage] || fallbackResponses['english'];
        fallbackMessage = languageFallbacks[Math.floor(Math.random() * languageFallbacks.length)];
      }
      
      aiResult = {
        response: fallbackMessage,
        responseTime: 0,
        aiType: 'fallback',
        success: true
      };
    }

    // Generate conversation ID
    conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Save interaction for learning (with error handling)
    try {
      const interaction = new AICoachInteraction({
        userId,
        userMessage: sanitizedMessage.trim(),
        aiResponse: aiResult.response,
        topic,
        responseTime: aiResult.responseTime,
        conversationId,
        language: detectedLanguage,
        aiType: aiResult.aiType
      });

      await interaction.save();
      if (process.env.NODE_ENV === 'development') { console.log(`AI Coach - User: ${userId}, AI: ${aiResult.aiType}, Topic: ${topic}, Response Time: ${aiResult.responseTime}ms`);
}
      // Cache successful responses for faster future access
      if (shouldCache(sanitizedMessage, aiResult.response)) {
        setCachedResponse(sanitizedMessage, detectedLanguage, aiResult.response);
        if (process.env.NODE_ENV === 'development') { console.log('💾 Response cached for future requests');}
      }

      res.json({
        success: true,
        data: {
          response: aiResult.response,
          timestamp: new Date().toISOString(),
          conversationId,
          topic,
          interactionId: interaction._id,
          aiType: aiResult.aiType,
          responseTime: aiResult.responseTime,
          language: detectedLanguage,
          fromCache: false,
          webSearch: webSearchStatus // Add web search status
        }
      });
    } catch (saveError) {
      // If saving fails, still return the AI response to the user
      log.error('Failed to save interaction:', { error: String(saveError) });
      
      res.json({
        success: true,
        data: {
          response: aiResult.response,
          timestamp: new Date().toISOString(),
          conversationId,
          topic,
          aiType: aiResult.aiType,
          responseTime: aiResult.responseTime,
          language: detectedLanguage,
          warning: 'Response generated but not saved to history'
        }
      });
    }

  } catch (error) {
    log.error('AI Coach Error:', { error: String(error) });
    // Return user-friendly error message based on language
    let errorMessage = 'Internal server error. Please try again.';
    
    if (detectedLanguage === 'roman_hindi') {
      errorMessage = 'Kuch galat ho gaya. Please thodi der baad try karo. 🙏';
    } else if (detectedLanguage === 'roman_marathi') {
      errorMessage = 'Kahi chuk jhali. Kripaya thodyavela nantar try kara. 🙏';
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get Multiple AI Responses (for comparison)
const getMultipleResponses = async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;
    const userId = req.user?.id;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }

    const detectedLanguage = detectLanguage(message);
    const topic = determineTopic(message);

    // Get responses from all AIs in parallel
    const aiPromises = Object.keys(AI_CONFIG).map(aiType => 
      callAI(aiType, message, conversationHistory, detectedLanguage)
    );

    const results = await Promise.allSettled(aiPromises);
    
    const responses = results
      .map((result, index) => {
        const aiType = Object.keys(AI_CONFIG)[index];
        if (result.status === 'fulfilled' && result.value.success) {
          return {
            aiType,
            response: result.value.response,
            responseTime: result.value.responseTime,
            success: true
          };
        }
        return {
          aiType,
          response: null,
          responseTime: 0,
          success: false,
          error: result.status === 'rejected' ? result.reason.message : 'Unknown error'
        };
      })
      .filter(result => result.success);

    // Generate conversation ID
    const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.json({
      success: true,
      data: {
        responses,
        conversationId,
        topic,
        language: detectedLanguage,
        totalAIs: responses.length
      }
    });

  } catch (error) {
    log.error('Multiple AI Responses Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get AI Status
const getAIStatus = async (req, res) => {
  try {
    const status = {};
    
    // Test each AI
    for (const [aiType, config] of Object.entries(AI_CONFIG)) {
      try {
        const testResult = await callAI(aiType, 'test', []);
        status[aiType] = {
          ...config,
          status: testResult.success ? 'online' : 'offline',
          responseTime: testResult.responseTime,
          lastChecked: new Date().toISOString()
        };
      } catch (error) {
        status[aiType] = {
          ...config,
          status: 'offline',
          error: process.env.NODE_ENV === 'development' ? error.message : undefined,
          lastChecked: new Date().toISOString()
        };
      }
    }

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    log.error('AI Status Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get Personalized Suggestions
const getPersonalizedSuggestions = async (req, res) => {
  try {
    const userId = req.user?.id;
    
    // Get user's recent interactions
    const recentInteractions = await AICoachInteraction.find({ userId })
      .sort({ timestamp: -1 })
      .limit(10);
    
    // Analyze user preferences
    const topics = recentInteractions.map(interaction => interaction.topic);
    const languages = recentInteractions.map(interaction => interaction.language);
    const aiTypes = recentInteractions.map(interaction => interaction.aiType);
    
    // Generate suggestions based on user history
    const suggestions = [];
    
    if (topics.includes('aim')) {
      suggestions.push({
        type: 'aim',
        title: 'Aim Training',
        description: 'Practice your aim with these exercises',
        icon: '🎯'
      });
    }
    
    if (topics.includes('rank')) {
      suggestions.push({
        type: 'rank',
        title: 'Rank Up Tips',
        description: 'Strategies to improve your ranking',
        icon: '📈'
      });
    }
    
    if (topics.includes('communication')) {
      suggestions.push({
        type: 'communication',
        title: 'Team Communication',
        description: 'Improve your callouts and teamwork',
        icon: '🗣️'
      });
    }
    
    // Add general suggestions
    suggestions.push(
      {
        type: 'warmup',
        title: 'Warmup Routine',
        description: 'Get ready for your gaming session',
        icon: '🔥'
      },
      {
        type: 'strategy',
        title: 'Game Strategies',
        description: 'Learn advanced gaming strategies',
        icon: '🎮'
      }
    );
    
    res.json({
      success: true,
      data: {
        suggestions: suggestions.slice(0, 5),
        userStats: {
          totalInteractions: recentInteractions.length,
          favoriteTopics: [...new Set(topics)],
          preferredLanguage: languages[0] || 'english',
          preferredAI: aiTypes[0] || 'gemini'
        }
      }
    });
    
  } catch (error) {
    log.error('Personalized Suggestions Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Rate AI Response
const rateResponse = async (req, res) => {
  try {
    const { interactionId, rating, feedback } = req.body;
    const userId = req.user?.id;
    
    if (!interactionId || !rating) {
      return res.status(400).json({
        success: false,
        message: 'Interaction ID and rating are required'
      });
    }
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }
    
    const interaction = await AICoachInteraction.findOne({
      _id: interactionId,
      userId
    });
    
    if (!interaction) {
      return res.status(404).json({
        success: false,
        message: 'Interaction not found'
      });
    }
    
    interaction.userRating = rating;
    if (feedback) {
      interaction.userFeedback = feedback;
    }
    
    // Calculate quality score
    const qualityScore = (rating * 20) + (interaction.responseTime < 2000 ? 10 : 0);
    interaction.qualityScore = qualityScore;
    
    await interaction.save();
    
    // Auto-learn from high-rated interactions (4+ stars)
    if (rating >= 4) {
      const { learnFromFeedback } = require('../utils/autoLearning');
      // Run async, don't block response
      learnFromFeedback(interactionId).catch(err => 
        log.error('Auto-learning error:', { error: String(err) })
      );
    }
    
    res.json({
      success: true,
      message: 'Rating saved successfully',
      data: {
        interactionId,
        rating,
        qualityScore,
        autoLearned: rating >= 4 // Indicate if auto-learning was triggered
      }
    });
    
  } catch (error) {
    log.error('Rate Response Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get Analytics
const getAnalytics = async (req, res) => {
  try {
    const userId = req.user?.id;
    
    // Get user's interactions
    const interactions = await AICoachInteraction.find({ userId });
    
    // Calculate analytics
    const totalInteractions = interactions.length;
    const averageRating = interactions.reduce((sum, interaction) => sum + (interaction.userRating || 0), 0) / totalInteractions;
    const averageResponseTime = interactions.reduce((sum, interaction) => sum + interaction.responseTime, 0) / totalInteractions;
    
    // Topic distribution
    const topicDistribution = interactions.reduce((acc, interaction) => {
      acc[interaction.topic] = (acc[interaction.topic] || 0) + 1;
      return acc;
    }, {});
    
    // Language distribution
    const languageDistribution = interactions.reduce((acc, interaction) => {
      acc[interaction.language] = (acc[interaction.language] || 0) + 1;
      return acc;
    }, {});
    
    // AI type distribution
    const aiTypeDistribution = interactions.reduce((acc, interaction) => {
      acc[interaction.aiType] = (acc[interaction.aiType] || 0) + 1;
      return acc;
    }, {});
    
    // Recent conversations
    const recentConversations = interactions
      .filter(interaction => interaction.conversationId)
      .reduce((acc, interaction) => {
        if (!acc[interaction.conversationId]) {
          acc[interaction.conversationId] = {
            conversationId: interaction.conversationId,
            topic: interaction.topic,
            language: interaction.language,
            aiType: interaction.aiType,
            messageCount: 0,
            averageRating: 0,
            lastMessage: interaction.timestamp,
            firstMessage: interaction.userMessage, // Add first message for title generation
            title: interaction.customTitle
          };
        }
        acc[interaction.conversationId].messageCount++;
        if (interaction.userRating) {
          acc[interaction.conversationId].averageRating = 
            (acc[interaction.conversationId].averageRating + interaction.userRating) / 2;
        }
        return acc;
      }, {});
    
    res.json({
      success: true,
      data: {
        totalInteractions,
        averageRating: Math.round(averageRating * 100) / 100,
        averageResponseTime: Math.round(averageResponseTime),
        topicDistribution,
        languageDistribution,
        aiTypeDistribution,
        recentConversations: Object.values(recentConversations).slice(0, 10)
      }
    });
    
  } catch (error) {
    log.error('Analytics Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get Conversation History
const getConversationHistory = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { conversationId } = req.params;
    
    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: 'Conversation ID is required'
      });
    }
    
    // Get all interactions for this conversation
    const interactions = await AICoachInteraction.find({ 
      userId, 
      conversationId 
    }).sort({ timestamp: 1 });
    
    if (interactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }
    
    // Format the conversation
    const messages = [];
    interactions.forEach(interaction => {
      messages.push({
        id: interaction._id.toString(),
        content: interaction.userMessage,
        type: 'user',
        timestamp: interaction.timestamp,
        mediaUrl: interaction.mediaUrl || undefined,
        mediaType: interaction.mediaType || undefined,
        analysisType: interaction.analysisType || undefined
      });
      messages.push({
        id: `${interaction._id}_response`,
        content: interaction.aiResponse,
        type: 'ai',
        timestamp: interaction.timestamp,
        interactionId: interaction._id.toString(),
        analysisType: interaction.analysisType || undefined
      });
    });
    
    res.json({
      success: true,
      data: {
        conversationId,
        messages,
        topic: interactions[0].topic,
        language: interactions[0].language,
        aiType: interactions[0].aiType,
        totalMessages: messages.length,
        createdAt: interactions[0].timestamp,
        lastUpdated: interactions[interactions.length - 1].timestamp
      }
    });
    
  } catch (error) {
    log.error('Get Conversation History Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Rename conversation
const renameConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { title } = req.body;
    const userId = req.user.id;

    if (!title || title.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Title is required'
      });
    }

    // Update the first interaction with custom title
    const result = await AICoachInteraction.updateOne(
      { conversationId, userId },
      { $set: { customTitle: title.trim() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    res.json({
      success: true,
      message: 'Conversation renamed successfully',
      data: { customTitle: title.trim() }
    });
  } catch (error) {
    log.error('Error renaming conversation:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to rename conversation'
    });
  }
};

// Delete conversation
const deleteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const result = await AICoachInteraction.deleteMany({
      conversationId,
      userId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    res.json({
      success: true,
      message: 'Conversation deleted successfully'
    });
  } catch (error) {
    log.error('Error deleting conversation:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to delete conversation'
    });
  }
};

// Get Cache Statistics
const getCacheStatistics = async (req, res) => {
  try {
    const stats = getCacheStats();
    
    const hitRate = stats.hits + stats.misses > 0 
      ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2)
      : 0;
    
    res.json({
      success: true,
      data: {
        totalKeys: stats.keys,
        hits: stats.hits,
        misses: stats.misses,
        hitRate: `${hitRate}%`,
        keySize: stats.ksize,
        valueSize: stats.vsize,
        message: 'Cache statistics retrieved successfully'
      }
    });
  } catch (error) {
    log.error('Cache Statistics Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to get cache statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Analyze Gameplay Image/Video with AI
const analyzeGameplay = async (req, res) => {
  let conversationId = null;
  let detectedLanguage = 'english';
  let mediaUrl = null;
  let mediaPublicId = null;
  let mediaType = 'text';
  let analysisType = 'general';

  try {
    const { message = '', analysisType: requestedAnalysisType = 'general' } = req.body;
    const userId = req.user?.id;
    const file = req.file;

    // Check if file is provided
    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload an image or video file'
      });
    }

    // Validate file type
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');

    if (!isImage && !isVideo) {
      return res.status(400).json({
        success: false,
        message: 'Only image and video files are supported'
      });
    }

    mediaType = isImage ? 'image' : 'video';
    analysisType = requestedAnalysisType;

    // Upload file to Cloudinary
    try {
      const uploadResult = isImage 
        ? await uploadImage(file, 'gaming-social/ai-coach')
        : await uploadVideo(file, 'gaming-social/ai-coach');
      
      mediaUrl = uploadResult.url;
      mediaPublicId = uploadResult.publicId;
    } catch (uploadError) {
      log.error('Cloudinary upload error:', { error: String(uploadError) });
      return res.status(500).json({
        success: false,
        message: 'Failed to upload file. Please try again.',
        error: uploadError.message
      });
    }

    // Detect language from message
    detectedLanguage = message ? detectLanguage(message) : 'english';

    // Get user preferences
    const userPreferences = await getUserPreferences(userId);

    // Prepare analysis prompt based on type
    let analysisPrompt = '';
    
    if (analysisType === 'rotation') {
      analysisPrompt = `You are analyzing a gameplay ${mediaType} to provide rotation analysis. 

CRITICAL ANALYSIS TASKS:
1. Identify player positions and team positioning
2. Analyze rotation timing - is it too early, too late, or optimal?
3. Check for rotation gaps or vulnerabilities
4. Evaluate rotation speed and coordination
5. Identify better rotation paths or alternatives
6. Assess map control during rotation
7. Check for information gathering before rotation
8. Evaluate utility usage during rotation

Provide detailed feedback on:
- Rotation timing and decision-making
- Positioning during rotation
- Team coordination
- Map control and information
- Alternative strategies
- Specific improvements

${message ? `User's question: ${message}` : 'Analyze the rotation in this gameplay.'}`;
    } else {
      analysisPrompt = `You are analyzing a gameplay ${mediaType} to provide coaching feedback.

CRITICAL ANALYSIS TASKS:
1. Analyze gameplay mechanics (aim, movement, positioning)
2. Identify strengths and weaknesses
3. Provide specific improvement suggestions
4. Evaluate decision-making
5. Assess game sense and awareness
6. Check for tactical errors
7. Suggest better strategies

${message ? `User's question: ${message}` : 'Analyze this gameplay and provide feedback.'}`;
    }

    // Language-specific instructions
    let languageInstruction = '';
    switch (detectedLanguage) {
      case 'roman_hindi':
        languageInstruction = `CRITICAL: Respond ONLY in Roman Hindi/Hinglish using English alphabet. NEVER use Devanagari script.`;
        break;
      case 'devanagari_hindi':
        languageInstruction = `CRITICAL: Respond ONLY in Hindi using Devanagari script.`;
        break;
      default:
        languageInstruction = `Respond in English.`;
    }

    // Use Gemini Vision API for image/video analysis
    // Gemini 2.0 Flash supports both images and videos
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    
    let systemPrompt = `You are an expert AI Gaming Coach specializing in gameplay analysis. You analyze gameplay images and videos to help players improve.

Your personality:
- Detailed and analytical
- Constructive and encouraging
- Provide specific, actionable feedback
- Use gaming terminology accurately
- Focus on improvement opportunities

${languageInstruction}

Response Format:
- Start with a brief overview
- Use bullet points with dashes (-) for key points
- Be specific about what you see in the ${mediaType}
- Provide actionable improvement suggestions
- Use emojis appropriately (🎯🔥🎮💰🔫📈🏆🗣️)
- Keep response detailed but organized (300-500 words)`;

    // Prepare content for Gemini Vision
    let contentParts = [systemPrompt + '\n\n' + analysisPrompt];
    
    if (isImage) {
      // For images, convert buffer to base64
      const base64Image = file.buffer.toString('base64');
      const mimeType = file.mimetype;
      
      contentParts.push({
        inlineData: {
          data: base64Image,
          mimeType: mimeType
        }
      });
    } else if (isVideo) {
      // For videos, Gemini 1.5 Pro can handle video files directly
      // Convert video buffer to base64
      const base64Video = file.buffer.toString('base64');
      const mimeType = file.mimetype;
      
      contentParts.push({
        inlineData: {
          data: base64Video,
          mimeType: mimeType
        }
      });
      
      // Alternative: If base64 doesn't work, we can use the URL
      // But for now, let's try base64 first
    }

    // Call Gemini Vision API
    const startTime = Date.now();
    const result = await model.generateContent(contentParts);
    const responseText = result.response.text();
    const responseTime = Date.now() - startTime;

    // Generate conversation ID
    conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Determine topic
    const topic = analysisType === 'rotation' ? 'general' :
                 message.toLowerCase().includes('aim') ? 'aim' :
                 message.toLowerCase().includes('valorant') ? 'valorant' :
                 message.toLowerCase().includes('csgo') || message.toLowerCase().includes('cs2') ? 'csgo' :
                 'general';

    // Save interaction
    try {
      const interaction = new AICoachInteraction({
        userId,
        userMessage: message || `Analyze this ${mediaType}`,
        aiResponse: responseText,
        topic,
        responseTime,
        conversationId,
        language: detectedLanguage,
        aiType: 'gemini',
        mediaType: message ? `${mediaType}+text` : mediaType,
        mediaUrl,
        mediaPublicId,
        analysisType
      });

      await interaction.save();
      if (process.env.NODE_ENV === 'development') { console.log(`AI Coach Analysis - User: ${userId}, Type: ${analysisType}, Media: ${mediaType}, Response Time: ${responseTime}ms`);
}
      res.json({
        success: true,
        data: {
          response: responseText,
          timestamp: new Date().toISOString(),
          conversationId,
          topic,
          interactionId: interaction._id,
          aiType: 'gemini',
          responseTime,
          language: detectedLanguage,
          mediaType,
          mediaUrl,
          analysisType
        }
      });
    } catch (saveError) {
      log.error('Failed to save interaction:', { error: String(saveError) });
      
      res.json({
        success: true,
        data: {
          response: responseText,
          timestamp: new Date().toISOString(),
          conversationId,
          topic,
          aiType: 'gemini',
          responseTime,
          language: detectedLanguage,
          mediaType,
          mediaUrl,
          analysisType,
          warning: 'Response generated but not saved to history'
        }
      });
    }

  } catch (error) {
    log.error('Gameplay Analysis Error:', { error: String(error) });
    
    // Clean up uploaded file if analysis fails
    if (mediaPublicId) {
      try {
        const { deleteFile } = require('../utils/cloudinary');
        await deleteFile(mediaPublicId);
      } catch (deleteError) {
        log.error('Failed to delete uploaded file:', { error: String(deleteError) });
      }
    }

    let errorMessage = 'Failed to analyze gameplay. Please try again.';
    
    if (detectedLanguage === 'roman_hindi') {
      errorMessage = 'Gameplay analyze karne mein problem hui. Please try again.';
    } else if (detectedLanguage === 'devanagari_hindi') {
      errorMessage = 'गेमप्ले विश्लेषण में समस्या हुई। कृपया पुनः प्रयास करें।';
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  chatWithAI,
  getMultipleResponses,
  getAIStatus,
  getPersonalizedSuggestions,
  rateResponse,
  getAnalytics,
  getConversationHistory,
  renameConversation,
  deleteConversation,
  getCacheStatistics,
  analyzeGameplay,
  callGemini,
  callAI
};
