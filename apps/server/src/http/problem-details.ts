import type { FastifyReply, FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// RFC 9457 Problem Details — standard error format for HTTP APIs
//
// https://www.rfc-editor.org/rfc/rfc9457
// Content-Type: application/problem+json
// ---------------------------------------------------------------------------

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function sendProblem(
  reply: FastifyReply,
  req: FastifyRequest,
  status: number,
  title: string,
  detail: string,
): void {
  const problem: ProblemDetails = {
    type: `https://harness.dev/errors/${status}`,
    title,
    status,
    detail,
    instance: req.url,
  };
  reply.status(status).header("content-type", PROBLEM_CONTENT_TYPE).send(problem);
}

export function notFound(reply: FastifyReply, req: FastifyRequest, detail: string): void {
  sendProblem(reply, req, 404, "Not Found", detail);
}

export function badRequest(reply: FastifyReply, req: FastifyRequest, detail: string): void {
  sendProblem(reply, req, 400, "Bad Request", detail);
}

export function unprocessable(reply: FastifyReply, req: FastifyRequest, detail: string): void {
  sendProblem(reply, req, 422, "Unprocessable Content", detail);
}
