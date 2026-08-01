export interface GitAuthorLike {
  name: string;
  email: string;
}

export declare const FORBIDDEN_NAMES: Set<string>;
export declare const FORBIDDEN_EMAIL_PATTERN: RegExp;
export declare function isForbiddenGitAuthor(author: GitAuthorLike): boolean;
export declare function findForbiddenAuthors<T extends GitAuthorLike>(commits: T[]): T[];
