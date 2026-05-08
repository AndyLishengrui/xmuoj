export const languageByExtension: Record<string, string> = {
  '.c': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.java': 'Java',
  '.py': 'Python3'
};

export function detectLanguage(filePath: string): string | undefined {
  const idx = filePath.lastIndexOf('.');
  if (idx < 0) {
    return undefined;
  }
  return languageByExtension[filePath.slice(idx).toLowerCase()];
}

export function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

export function contestStatus(now: Date, startAt?: string, endAt?: string): '进行中' | '准备中' | '已结束' | undefined {
  if (!startAt || !endAt) {
    return undefined;
  }
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const current = now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  if (current < start) {
    return '准备中';
  }
  if (current > end) {
    return '已结束';
  }
  return '进行中';
}

export function defaultCodeTemplate(language: string): string {
  switch (language) {
    case 'C':
      return '#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n';
    case 'C++':
      return '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    return 0;\n}\n';
    case 'Java':
      return 'public class Main {\n    public static void main(String[] args) {\n    }\n}\n';
    case 'Python3':
      return 'def main():\n    pass\n\nif __name__ == "__main__":\n    main()\n';
    default:
      return '';
  }
}

export function finalVerdict(status: string): boolean {
  return ['Accepted', 'Wrong Answer', 'Runtime Error', 'Compile Error', 'Time Limit Exceeded', 'Memory Limit Exceeded', 'Presentation Error', 'Output Limit Exceeded', 'System Error'].includes(status);
}
