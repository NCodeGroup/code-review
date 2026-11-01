// The escaping the bot's comments share for text from a pull request or a model.

// Stops @mentions in quoted text from notifying anyone: a zero-width space after the @, which the training reader
// removes again.
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
}

// Text for a code span or a link's text: without a backtick, bracket or line break, which could end it or start a link.
export function plainText(text: string): string {
  return text.replace(/[`\[\]\r\n]/g, '');
}
