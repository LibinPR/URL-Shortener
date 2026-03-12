import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

//Logs every incomimg requets with method , path , status code and duration

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    //record when request arrived

    const start = Date.now();

    // 'finish' fires after the response has been fully sent to the client
    // At this point res.statusCode is final and Date.now() - start = total duration
    res.on('finish' , () => {
        const duration = Date.now()-start;

        //choose log level based on status code
        //5xx - backend fault
        //4xx - client fault
        //rest - info

        const level = 
        res.statusCode>=500? 'error' :
        res.statusCode>=400? 'warn' :
        'info';

        logger[level](`${req.method} ${req.path}`, {
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
        });
    });

    //pass to next middleware
    next();
}
