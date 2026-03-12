import { Request, Response, NextFunction } from 'express';
import { UrlService } from '../services/url.service';
import { ShortenSchema } from '../utils/validation';

export class UrlController {
    constructor(private readonly service: UrlService) {}

   // POST /api/urls
  // Body: { url, customAlias?, expiresInDays? }
  shorten = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // parse and validate req body
      // safeParse never throws — returns { success: true, data } or
      // { success: false, error } so we handle both cases
      const parsed = ShortenSchema.safeParse(req.body);

      if (!parsed.success) {
        // Zod gives us detailed errors per field
        // We format them into a clean array for the API consumer
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: parsed.error.issues.map((e) => ({
              field: e.path.join('.'), 
              message: e.message,
            })),
          },
        });
        return; // must return after sending response or we'll try to send another response later and crash
      }

      const { url, customAlias, expiresInDays } = parsed.data;

      // Convert expiresInDays (a number) into an actual Date object.
      // The service works with Dates, not "days from now" numbers.
      // This conversion is a controller concern — it's about interpreting
      // the HTTP input format, not a business rule.
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const result = await this.service.shorten({
        originalUrl: url,
        customAlias,
        expiresAt,
      });

      // 201 Resource Created — specifically
      // 200 OK - generic
      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (err) {
      // Pass ALL errors to the error middleware.
      // It knows how to convert AppError subclasses to proper HTTP responses.
      next(err);
    }
  };

    //GET /:shortCode
    //core feat - resolves shortCode & redirects to original URL

    redirect = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const shortCode = req.params['shortCode'] as string;

            //shortCode comes from URL
            //TS says it cd be undefined bcz req.params is loose
            //so we assert it with ! after confirming route definition guarantees its presence
            const originalUrl = await this.service.resolve(shortCode!);

            //302 FOund - its temporary redirect
            //browser auto follows it & goes to orinalUrl
            //why 302 specifcally
            // 301 is cached by browsers permanently — they never ask us again.
            // That means we can never track clicks after the first visit.
            // 302 means browser always asks us — we always count the click.
            res.status(302).redirect(originalUrl);
        } catch(err) {
            next(err);
        }
    };


    // GET /api/urls/:shortCode/stats
    getStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const shortCode = req.params['shortCode'] as string;
            const stats = await this.service.getStats(shortCode!);

            res.status(200).json({
                success : true,
                data : stats,
            });
        } catch (err) {
            next(err)
        }
    };

    // DELETE /api/urls/:shortCode
  deactivate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const shortCode = req.params['shortCode'] as string;
      await this.service.deactivate(shortCode!);

      // 200 with a message — not 204 No Content.
      // 204 has no body. We return a message so API consumers
      // get confirmation of what was deactivated.
      res.status(200).json({
        success: true,
        message: `Short URL '${shortCode}' has been deactivated`,
      });
    } catch (err) {
      next(err);
    }
  };
} 