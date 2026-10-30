import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { toProblem } from '../lib/errors.js';

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = req.ctx?.requestId ?? 'unknown';
    // body-parser errors
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ type: 'urn:examos:error:MALFORMED_JSON', title: 'Malformed JSON body', status: 400, code: 'MALFORMED_JSON', requestId, retryable: false });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ type: 'urn:examos:error:PAYLOAD_TOO_LARGE', title: 'Payload too large', status: 413, code: 'PAYLOAD_TOO_LARGE', requestId, retryable: false });
      return;
    }
    const problem = toProblem(err, requestId);
    if (problem.status >= 500) logger.error({ err, requestId, path: req.path }, 'unhandled error');
    else if (problem.status === 409 || problem.status === 403) logger.info({ code: problem.code, requestId, path: req.path }, 'request refused');
    res.status(problem.status).type('application/problem+json').json(problem);
  };
}
