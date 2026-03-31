declare module "express" {
  export interface Request {
    body: any;
    params: any;
    query: any;
    headers: any;
    [key: string]: any;
  }

  export interface Response {
    status(code: number): Response;
    json(body: any): Response;
    send(body?: any): Response;
    [key: string]: any;
  }

  export type NextFunction = (err?: any) => void;

  export type RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => any;

  export interface Router {
    get(path: string, ...handlers: RequestHandler[]): Router;
    post(path: string, ...handlers: RequestHandler[]): Router;
    put(path: string, ...handlers: RequestHandler[]): Router;
    delete(path: string, ...handlers: RequestHandler[]): Router;
    use(...handlers: RequestHandler[]): Router;
  }

  export function Router(): Router;

  export interface Application extends Router {
    listen(port: number, callback?: () => void): any;
    use(path: string, router: Router): Application;
    use(handler: RequestHandler): Application;
  }

  export default function express(): Application;
}
