import OpenAI from "openai";
import sharp from "sharp";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult } from "./types";
import { generateAnalyzePrompt, generateSimilarQuestionPrompt } from './prompts';
import { getAppConfig } from '../config';
import { safeParseParsedQuestion } from './schema';
import { getMathTagsFromDB, getTagsFromDB } from './tag-service';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';

const logger = createLogger('ai:modelscope');

/** ModelScope VL models have a 2048×2048 input size limit */
const MAX_IMAGE_DIMENSION = 2048;

async function resizeImageIfNeeded(imageBase64: string): Promise<{ base64: string; originalWidth: number; originalHeight: number; newWidth: number; newHeight: number }> {
    const buffer = Buffer.from(imageBase64, 'base64');
    const metadata = await sharp(buffer).metadata();
    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;

    if (originalWidth <= MAX_IMAGE_DIMENSION && originalHeight <= MAX_IMAGE_DIMENSION) {
        return { base64: imageBase64, originalWidth, originalHeight, newWidth: originalWidth, newHeight: originalHeight };
    }

    // Scale down so the larger dimension fits within MAX_IMAGE_DIMENSION, maintaining aspect ratio
    const scale = MAX_IMAGE_DIMENSION / Math.max(originalWidth, originalHeight);
    const newWidth = Math.round(originalWidth * scale);
    const newHeight = Math.round(originalHeight * scale);

    const resizedBuffer = await sharp(buffer)
        .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

    logger.info({
        originalWidth,
        originalHeight,
        newWidth,
        newHeight,
        scale: scale.toFixed(3),
    }, 'Image resized to fit ModelScope 2048×2048 limit');

    return {
        base64: resizedBuffer.toString('base64'),
        originalWidth,
        originalHeight,
        newWidth,
        newHeight,
    };
}

type OpenAIUserContent = string | Array<
    { type: "text"; text: string } |
    { type: "image_url"; image_url: { url: string } }
>;

export class ModelScopeProvider implements AIService {
    private openai: OpenAI;
    private model: string;
    private baseURL: string;
    private apiKey: string;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseURL = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: MODELSCOPE_API_KEY is required for ModelScope provider");
        }

        this.openai = new OpenAI({
            apiKey: apiKey,
            baseURL: baseURL || 'https://api-inference.modelscope.cn/v1',
            defaultHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        this.model = config?.model || 'Qwen/Qwen3-VL-8B-Instruct';
        this.baseURL = baseURL || 'https://api-inference.modelscope.cn/v1';
        this.apiKey = apiKey;

        logger.info({
            provider: 'ModelScope',
            model: this.model,
            baseURL: this.baseURL,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        }, 'AI Provider initialized');
    }

    private extractTag(text: string, tagName: string): string | null {
        const startTag = `<${tagName}>`;
        const endTag = `</${tagName}>`;
        const startIndex = text.indexOf(startTag);

        if (startIndex === -1) {
            return null;
        }

        const contentStartIndex = startIndex + startTag.length;
        const endIndex = text.lastIndexOf(endTag);

        if (endIndex === -1 && tagName === 'analysis') {
            logger.warn({ tagName }, 'Tag was verified unclosed, treating as truncated and reading to end');
            return text.substring(contentStartIndex).trim();
        }

        if (endIndex === -1 || contentStartIndex >= endIndex) {
            return null;
        }

        return text.substring(contentStartIndex, endIndex).trim();
    }

    private parseResponse(text: string): ParsedQuestion {
        logger.debug({ textLength: text.length }, 'Parsing AI response');

        const questionText = this.extractTag(text, "question_text");
        const answerText = this.extractTag(text, "answer_text");
        const analysis = this.extractTag(text, "analysis");
        const subjectRaw = this.extractTag(text, "subject");
        const knowledgePointsRaw = this.extractTag(text, "knowledge_points");
        const requiresImageRaw = this.extractTag(text, "requires_image");
        const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
        const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
        const mistakeStatusRaw = this.extractTag(text, "mistake_status");

        if (!questionText || !answerText || !analysis) {
            logger.error({ rawTextSample: text.substring(0, 500) }, 'Missing critical XML tags');
            throw new Error("Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)");
        }

        let subject: ParsedQuestion['subject'] = '其他';
        const validSubjects: ParsedQuestion['subject'][] = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
        if (subjectRaw && (validSubjects as string[]).includes(subjectRaw)) {
            subject = subjectRaw as ParsedQuestion['subject'];
        }

        let knowledgePoints: string[] = [];
        if (knowledgePointsRaw) {
            knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
        }

        const requiresImage = requiresImageRaw?.toLowerCase().trim() === 'true';
        const mistakeStatus = normalizeMistakeStatusForSave(mistakeStatusRaw, wrongAnswerText);

        const result: ParsedQuestion = {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            subject,
            knowledgePoints,
            requiresImage
        };

        const validation = safeParseParsedQuestion(result);
        if (validation.success) {
            logger.debug('Validated successfully via XML tags');
            return validation.data;
        } else {
            logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
            return result;
        }
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();

        const prefetchedMathTags = (subject === '数学' || !subject) ? await getMathTagsFromDB(grade || null) : [];
        const prefetchedPhysicsTags = (subject === '物理' || !subject) ? await getTagsFromDB('physics') : [];
        const prefetchedChemistryTags = (subject === '化学' || !subject) ? await getTagsFromDB('chemistry') : [];
        const prefetchedBiologyTags = (subject === '生物' || !subject) ? await getTagsFromDB('biology') : [];
        const prefetchedEnglishTags = (subject === '英语' || !subject) ? await getTagsFromDB('english') : [];

        const systemPrompt = generateAnalyzePrompt(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            prefetchedMathTags,
            prefetchedPhysicsTags,
            prefetchedChemistryTags,
            prefetchedBiologyTags,
            prefetchedEnglishTags,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'ModelScope',
            endpoint: `${this.baseURL}/chat/completions`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.model,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full System Prompt', systemPrompt);

        // Resize image if it exceeds ModelScope's 2048×2048 limit
        const { base64: resizedImageBase64 } = await resizeImageIfNeeded(imageBase64);

        try {
            const requestParamsForLog = {
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,[...${imageBase64.length} bytes base64 data...]`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 4096,
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,${resizedImageBase64}`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 4096,
            });

            logger.box('📦 Full API Response', JSON.stringify(response, null, 2));

            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = response.choices[0]?.message?.content || "";

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const systemPrompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar
        }, gradeSemester);
        const userPrompt = `\nOriginal Question: "${originalQuestion}"\nKnowledge Points: ${knowledgePoints.join(", ")}\n    `;

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'ModelScope',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.model,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 System Prompt', systemPrompt);
        logger.box('📝 User Prompt', userPrompt);

        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                max_tokens: 4096,
            });

            const text = response.choices[0]?.message?.content || "";

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult> {
        const { generateReanswerPrompt } = await import('./prompts');
        const prompt = generateReanswerPrompt(language, questionText, subject, undefined, gradeSemester);

        logger.info({
            provider: 'ModelScope',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.model,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ prompt }, 'Full prompt');

        try {
            let userContent: OpenAIUserContent = "请根据上述题目提供答案和解析。";
            if (imageBase64) {
                // Extract pure base64 (strip data: prefix if present) for resize
                let pureBase64 = imageBase64;
                let mimePrefix = 'image/jpeg';
                if (imageBase64.startsWith('data:')) {
                    const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
                    if (matches) {
                        mimePrefix = matches[1];
                        pureBase64 = matches[2];
                    } else {
                        pureBase64 = imageBase64.split(',')[1] || imageBase64;
                    }
                }
                const { base64: resizedBase64 } = await resizeImageIfNeeded(pureBase64);
                const imageUrl = `data:${mimePrefix};base64,${resizedBase64}`;
                logger.debug({ imageLength: imageUrl.length }, 'Image added to request');
                userContent = [
                    { type: "text", text: "请结合图片和题目描述提供答案和解析。" },
                    { type: "image_url", image_url: { url: imageUrl } }
                ];
            }

            const requestParams = {
                model: this.model,
                messages: [
                    { role: "system", content: prompt.substring(0, 200) + "..." },
                    { role: "user", content: typeof userContent === 'string' ? userContent : "[包含图片的多模态消息]" }
                ],
                max_tokens: 4096
            };
            logger.debug({ requestParams }, 'Request parameters');

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: userContent }
                ],
                max_tokens: 4096,
            });

            logger.debug({ response: JSON.stringify(response) }, 'Full API response');

            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = response.choices[0]?.message?.content || "";

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

            const answerText = this.extractTag(text, "answer_text") || "";
            const analysis = this.extractTag(text, "analysis") || "";
            const knowledgePointsRaw = this.extractTag(text, "knowledge_points") || "";
            const knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
            const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
            const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
            const mistakeStatus = normalizeMistakeStatusForSave(
                this.extractTag(text, "mistake_status"),
                wrongAnswerText
            );

            logger.info('Reanswer parsed successfully');

            return { answerText, analysis, knowledgePoints, wrongAnswerText, mistakeAnalysis, mistakeStatus };

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
            throw error;
        }
    }

    private handleError(error: unknown) {
        logger.error({ error }, 'ModelScope error');
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect')) {
                throw new Error("AI_CONNECTION_FAILED");
            }
            if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408')) {
                throw new Error("AI_TIMEOUT_ERROR");
            }
            if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
                throw new Error("AI_QUOTA_EXCEEDED");
            }
            if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
                throw new Error("AI_PERMISSION_DENIED");
            }
            if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
                throw new Error("AI_NOT_FOUND");
            }
            if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
                msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
                throw new Error("AI_SERVICE_UNAVAILABLE");
            }
            if (msg.includes('invalid json') || msg.includes('parse')) {
                throw new Error("AI_RESPONSE_ERROR");
            }
            if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
                throw new Error("AI_AUTH_ERROR");
            }
        }
        throw new Error("AI_UNKNOWN_ERROR");
    }
}
