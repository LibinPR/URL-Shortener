import {
  IUrlRepository,
  ICache,
  CreateUrlDto,
  UrlResponse,
  UrlStats,
  NotFoundError,
  ConflictError,
  ValidationError,
  GoneError,
} from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isValidCode } from '../utils/base62';

//namespace all URL cache keys under 'url:'
//avoids collision if Redis is shared or other keys are added later
//'url:abc123' is instantly recognizable in Redis inspectio tools

const CACHE_PREFIX = 'url:';

function cacheKey(shortCode: string): string {
  return `${CACHE_PREFIX}${shortCode}`;
}

export class UrlService {
    constructor(
        private readonly repo : IUrlRepository,
        private readonly cache: ICache
    ) {}

    async shorten(dto: CreateUrlDto): Promise<UrlResponse> {
        //validate url format first
        //wrap in try/catch to convert ZodError to our ValidationError
        //enforec only http/https only, no ftp:// or data: URLs etc

        try{
            const parsed = new URL(dto.originalUrl);
            if(!['http:' , 'https:'].includes(parsed.protocol)) {
                throw new ValidationError('URL must use http or https protocol');
            }
        } catch(err) {
            if(err instanceof ValidationError) throw err;
            throw new ValidationError('Invalid URL format');
        }

        //validate custom alies if provided
        if(dto.customAlias) {
            if(!isValidCode(dto.customAlias)) {
                throw new ValidationError('customAlias can be 4-30 characters and only contain letters, numbers, hyphens, and underscores');
            }

            //check if custom alias is already taken
            const existing = await this.repo.findByShortCode(dto.customAlias);
            if(existing) {
                `Custom alias '${dto.customAlias}' is already in use`;
            }
        }

        // If this exact URL was already shortened and is still active,
        // return the existing short URL instead of creating a duplicate.
        // This is a product decision — some shorteners always create new codes.
        // We chose deduplication for cleanliness.
        // We skip deduplication if a custom alias is requested
        // (user explicitly wants a specific code, so create a new entry)

        if(!dto.customAlias) {
            const existing = await this.repo.findByOriginalUrl(dto.originalUrl);
            if(existing) {
                logger.debug('URL already exists , returning existing' , { shortCode : existing.shortCode,
                });
                return this.buildResponse(existing.shortCode , existing.originalUrl , existing.expiresAt , existing.createdAt);
            }
        }

        //creating new short url
        const url = await this.repo.create(dto);

        logger.info('URL shortened' , {
            shoortCode : url.shortCode,
            //log just starting 50 chars to avoid messy logs and block sensitive info being logged in full
            originalUrl : url.originalUrl.substring(0,50),
        });

        return this.buildResponse(url.shortCode , url.originalUrl , url.expiresAt , url.createdAt);
    }


    async resolve(shortCode: string): Promise<string> {

        //check cache first
        //cache stores orginalUrl - nothing else
        //if we store full url object we then need to serialize/deserialize JSON
        //storing string is much fast & simpler

        const cached = await this.cache.get(cacheKey(shortCode));

        if(cached) {
            logger.debug('Cache HIT' , { shortCode });

            //Target the click - fire & foregt
            //DONT await this. The redirect must not wait for a DB write
            //If this FAILS,then click is not counted - TRADEOFF[acceptable]
            this.trackClick(shortCode);
            
            return cached;
        }

        //if cache missed
        logger.debug('Cache MISS' , { shortCode });
        const url = await this.repo.findByShortCode(shortCode);

        //Validate the result
        if(!url) {
            throw new NotFoundError('Short URL');
        }

        if(!url.isActive) {
            //treat deactivated URLs as not found
            //Dont tell the caller it exissts but is deactiavted
            //that leaks info abt deleted url
            throw new NotFoundError('Short URL');
        }

        if(url.expiresAt && url.expiresAt < new Date()) {
            //410 GONE - different from 404
            //404 means "never existed" , 410 means "existed but no longer available"
            //Helps SEO and analytics to understand why links are dead
            throw new GoneError();
        }

        //populate cache for next time
        //calualte TTl -Time To Live - dont cache past theexpiry date
        //if url expires in 2 hrs cache for max 2hrs not default[7days] or 24hrs
        
        const ttl = this.computeTtl(url.expiresAt);
        await this.cache.set(cacheKey(shortCode) , url.originalUrl , ttl);

        //track click & return original URL
        this.trackClick(shortCode); 
        return url.originalUrl;
    }

    async getStats(shortCode: string): Promise<UrlStats> {
        //stats always get from DB - we want real-time accuracy here
        //we dont cache stats because they change on every click - caching would be ineffective and lead to stale data

        const url = await this.repo.getStats(shortCode);

        if(!url) {
            throw new NotFoundError('Short URL');
        }

        //return only what the API needs - not the full Url object
        //we return clickCount , createdAt , expiresAt , isActive
        return {
            shortCode : url.shortCode,
            originalUrl : url.originalUrl,
            clickCount : url.clickCount,
            createdAt : url.createdAt, 
            expiresAt : url.expiresAt,
            isActive : url.isActive,
        };
    }

    async deactivate(shortCode: string): Promise<void> {
        const wasDeactivated = await this.repo.deactivate(shortCode);

        if(!wasDeactivated) {
            throw new NotFoundError('Short URL');
        }

        //CRITICAl: invalidate cache immediately to prevent serving stale data
        //if we dont do this , the cache still has OLD url
        //someone cd redirect to the original URL even after deactivation - BAD
        //del() is idempotent - safe to call even if key doesnt exist
        await this.cache.del(cacheKey(shortCode));

        logger.info('URL deactivated' , { shortCode });
    }

    // Fires click increment without awaiting — caller continues immediately.
  // The void return type and lack of await is intentional.
  // Errors are caught inside incrementClicks() in the repository.
  private trackClick(shortCode: string): void {
    // Calling an async function without await — intentional fire-and-forget.
    // The promise runs in the background. If it rejects, the rejection
    // is already handled inside repo.incrementClicks (it logs and swallows).
    void this.repo.incrementClicks(shortCode);
  }

  // Computes how long to cache a URL in Redis.
  // If the URL expires sooner than our default TTL, use the shorter time.
  // This prevents serving a cached URL after it has expired.
  private computeTtl(expiresAt: Date | null): number {
    if (!expiresAt) {
      // No expiry — cache for full default TTL (24 hours)
      return config.redis.ttlSeconds;
    }

    const secondsUntilExpiry = Math.floor(
      (expiresAt.getTime() - Date.now()) / 1000
    );

    if (secondsUntilExpiry <= 0) {
      // Already expired — don't cache at all
      return 0;
    }

    // Cache for whichever is shorter: time until expiry OR default TTL
    return Math.min(secondsUntilExpiry, config.redis.ttlSeconds);
  }

  // Builds the UrlResponse object returned to the API consumer.
  // Constructs the full shortUrl from base URL + short code.
  private buildResponse(
    shortCode: string,
    originalUrl: string,
    expiresAt: Date | null,
    createdAt: Date
  ): UrlResponse {
    return {
      shortCode,
      shortUrl: `${config.server.baseUrl}/${shortCode}`,
      originalUrl,
      expiresAt,
      createdAt,
    };
  }
} 