FROM public.ecr.aws/lambda/nodejs:20

COPY package*.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev

COPY src ${LAMBDA_TASK_ROOT}/src

CMD ["src/handler.handler"]
