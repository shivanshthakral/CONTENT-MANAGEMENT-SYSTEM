import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const PORT = 3000;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enable CORS for frontend communication
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const upload = multer({
    dest: uploadsDir,
    fileFilter: (req, file, cb) => {
        // Allow all file types for now, filtering will happen based on extension/mimetype later
        cb(null, true);
    },
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB limit per file
    }
});

// Initialize Google Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Function to parse PDF buffer
async function parsePdfBuffer(buffer) {
    const options = {
        pagerender: function(pageData) {
            return pageData.getTextContent()
                .then(function(textContent) {
                    let lastY, text = '';
                    for (let item of textContent.items) {
                        if (lastY == item.transform[5] || !lastY) {
                            text += item.str;
                        } else {
                            text += '\n' + item.str;
                        }
                        lastY = item.transform[5];
                    }
                    return text;
                });
        }
    };

    const data = await pdfParse(buffer, options);
    return data.text;
}

// Function to read PDF content from file path
async function readPDFContent(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        return await parsePdfBuffer(dataBuffer);
    } catch (error) {
        console.error('Error reading PDF from file:', error);
        throw new Error('Failed to read PDF file. Please ensure it is a valid PDF.');
    }
}

// Function to extract text from PDF buffer (for URLs)
async function extractTextFromPDF(buffer) {
    try {
        return await parsePdfBuffer(buffer);
    } catch (error) {
        console.error('Error extracting text from PDF buffer:', error);
        throw new Error('Failed to extract text from PDF from URL.');
    }
}

// Function to extract content from URL
async function extractContentFromUrl(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' }); // Use axios for better buffer handling
        const contentType = response.headers['content-type'];
        let content = '';

        if (contentType && contentType.includes('application/pdf')) {
            // Handle PDF content
            content = await extractTextFromPDF(response.data);
        } else if (contentType && contentType.includes('text/html')) {
            // Handle HTML content
            content = await extractTextFromHTML(response.data.toString('utf8'));
        } else {
            console.warn(`Unsupported content type for URL ${url}: ${contentType}`);
            return ''; // Or throw an error
        }

        // Clean and structure the content
        content = cleanAndStructureContent(content);

        return content;
    } catch (error) {
        console.error('Error extracting content from URL:', error);
        throw new Error(`Failed to extract content from URL ${url}: ${error.message}`);
    }
}

async function extractTextFromHTML(html) {
    try {
        const $ = cheerio.load(html);

        // Remove unwanted elements
        $('script, style, nav, footer, header, iframe, noscript, .sidebar, .ad, .advertisement').remove();

        // Extract main content from common containers
        let content = '';
        const mainContentSelectors = 'main, article, .content, #content, .main-content, #main-content, .post-content, .entry-content';
        const mainContent = $(mainContentSelectors);

        if (mainContent.length > 0) {
            content = mainContent.text();
        } else {
            // Fallback to body content, but with more aggressive cleaning for common noise
            content = $('body').text();
        }

        // Clean up the content
        content = content
            .replace(/\s+/g, ' ') // Replace multiple whitespace with a single space
            .replace(/\n+/g, '\n') // Normalize multiple newlines
            .replace(/([.,!?])\s+/g, '$1 ') // Ensure space after punctuation
            .replace(/\s+([.,!?])/g, '$1') // Remove space before punctuation
            .replace(/\n\s*\n/g, '\n\n') // Normalize paragraph breaks
            .trim();

        return content;
    } catch (error) {
        console.error('Error extracting text from HTML:', error);
        throw new Error('Failed to extract text from HTML content');
    }
}

function cleanAndStructureContent(content) {
    // Remove extra whitespace and normalize line breaks
    content = content
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
    
    // Split into paragraphs
    const paragraphs = content.split(/\n\n+/);
    
    // Filter out very short paragraphs and clean each paragraph
    const cleanedParagraphs = paragraphs
        .map(p => p.trim())
        .filter(p => p.length > 50) // Increased minimum length to filter out more noise
        .map(p => {
            // Clean up punctuation and spacing
            return p
                .replace(/\s+([.,!?])/g, '$1')
                .replace(/([.,!?])\s+/g, '$1 ')
                .replace(/\s+/g, ' ')
                .trim();
        });
    
    // Join paragraphs with proper spacing
    return cleanedParagraphs.join('\n\n');
}

// Helper function to process AI response: strip markdown and safely parse JSON
function processAIResponse(text) {
    let jsonString = text;

    // Attempt to find and extract JSON string by looking for the first '{' or '[' and last '}' or ']'
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');

    let startIndex = -1;
    let endIndex = -1;

    // Determine the start index: min of first brace or bracket if found
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIndex = firstBrace;
    } else if (firstBracket !== -1) {
        startIndex = firstBracket;
    }

    // Determine the end index: max of last brace or bracket if found
    if (lastBrace !== -1 && (lastBracket === -1 || lastBrace > lastBracket)) {
        endIndex = lastBrace;
    } else if (lastBracket !== -1) {
        endIndex = lastBracket;
    }

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        jsonString = text.substring(startIndex, endIndex + 1);
    }

    // Try to parse the extracted string as JSON
    try {
        const parsed = JSON.parse(jsonString);
        return JSON.stringify(parsed, null, 2); // Pretty-print for consistency
    } catch (jsonError) {
        console.error('Failed to parse JSON. Attempted to parse:', jsonString, 'Raw text:', text, 'Error:', jsonError);
        // As a last resort, return the original text. The frontend should display it as raw text.
        return String(text);
    }
}

// Function to get company context from context.html
async function getCompanyContext() {
    try {
        const contextHtmlPath = path.join(__dirname, 'context.html');
        const html = fs.readFileSync(contextHtmlPath, 'utf8');
        const $ = cheerio.load(html);

        let companyContext = '';

        // Extract text from relevant sections. Prioritize content within specific elements.
        $('h1, h2, h3, p, li').each((i, el) => {
            let text = $(el).text().trim();
            if (text) {
                // Add a newline for block elements to maintain readability
                if (el.tagName === 'p' || el.tagName === 'li' || el.tagName.startsWith('h')) {
                    companyContext += text + '\n';
                } else {
                    companyContext += text + ' ';
                }
            }
        });

        // Further clean up the extracted text
        companyContext = companyContext
            .replace(/\s+/g, ' ') // Replace multiple spaces with a single space
            .replace(/\n\s*\n/g, '\n\n') // Normalize multiple newlines
            .trim();

        // Limit context length if it's too large
        const MAX_CONTEXT_LENGTH = 5000; // Limit to 5000 characters
        if (companyContext.length > MAX_CONTEXT_LENGTH) {
            companyContext = companyContext.substring(0, MAX_CONTEXT_LENGTH) + '...';
        }

        return companyContext;
    } catch (error) {
        console.error('Error reading company context from context.html:', error);
        return ''; // Return empty string if context cannot be read
    }
}

// Route to serve the landing page (default route)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "landing.html"));
});

// Route to serve the content generator page
app.get("/generator", (req, res) => {
    res.sendFile(path.join(__dirname, "generator.html"));
});

// Route to serve the context page
app.get("/context", (req, res) => {
    res.sendFile(path.join(__dirname, "context.html"));
});

// New route to handle multiple PDF/URL inputs and summary generation
app.post('/generate-summary-multiple', upload.any(), async (req, res) => {
    try {
        // Load prompts from prompts.json
        const promptsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));
        const prompts = {};
        for (const [tplId, template] of Object.entries(promptsData.templates)) {
            prompts[tplId] = `Analyze the following combined document content and generate content for a ${template.name} template. Format the response as a clean, well-structured JSON object.\n\n${template.instructions.join('\n')}\n\nFields to generate:\n${JSON.stringify(template.fields, null, 4)}\n\nYou must combine and synthesize information from ALL the provided documents and URLs. Do not focus on just one source. Generate a comprehensive response that integrates all topics and includes keywords from all sources.`;
        }

        const templateId = req.body.template;
        const prompt = prompts[templateId];
        let allContent = '';

        // Process all PDF files
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const pdfPath = file.path;
                const pdfContent = await readPDFContent(pdfPath);
                allContent += `\n\nDocument Content:\n${pdfContent}`;
                // Clean up the temporary file
                fs.unlinkSync(pdfPath);
            }
        }

        // Process all URLs
        const urlKeys = Object.keys(req.body).filter(key => key.startsWith('url'));
        for (const urlKey of urlKeys) {
            const url = req.body[urlKey];
            if (url) {
                try {
                    const urlContent = await extractContentFromUrl(url);
                    allContent += `\n\nURL Content (${url}):\n${urlContent}`;
                } catch (error) {
                    console.error(`Error fetching URL ${url}:`, error);
                }
            }
        }

        // Get company context
        const companyContext = await getCompanyContext();

        // Combine all content with the prompt and company context
        const fullPrompt = `${prompt}\n\nCompany Context:\n${companyContext}\n\nInput Content (combined from ALL provided documents and URLs):\n${allContent}\n\nYou must combine and synthesize information from ALL the provided documents and URLs. Do not focus on just one source. Generate a comprehensive response that integrates all topics and includes keywords from all sources.`;

        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        let text = response.text();

        // Log the raw AI response for debugging purposes
        console.log('Raw AI Response:', text);

        const processedJson = processAIResponse(text);
        
        res.json({ summary: processedJson });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to validate URL format
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Open http://localhost:${PORT} in your browser to use the application`);
});
