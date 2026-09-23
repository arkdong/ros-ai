# Local execution image. Runtime containers have no network and cannot install packages.
# Pin the resulting image ID in every captured execution capability snapshot.
FROM python:3.12.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1
RUN python -m pip install --no-cache-dir numpy==2.2.6 pandas==2.2.3 matplotlib==3.10.3 scipy==1.15.3
COPY sandbox_worker.py /opt/ros/sandbox_worker.py
RUN chmod 0555 /opt/ros/sandbox_worker.py && mkdir /input /work
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python", "-I", "/opt/ros/sandbox_worker.py"]
