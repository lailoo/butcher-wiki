// 问题域数据类型
export interface ProblemDomain {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  tags: string[];
  solution_count?: number;
}

// 解决方案
export interface Solution {
  id: string;
  domain_id: string;
  project: string;
  title: string;
  design_philosophy: string[];
  mechanism: string;
  code_snippets: CodeSnippet[];
  pros: string[];
  cons: string[];
  applicable_scenarios: string[];
  related_domains: string[];
}

// 代码片段
export interface CodeSnippet {
  file: string;
  lines: string;
  language: string;
  code: string;
  explanation: string;
}

// 项目引用
export interface ProjectRef {
  name: string;
  slug: string;
  repo: string;
  language: string;
  description: string;
  domains: string[];
}
