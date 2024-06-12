import psycopg2

class Postgres:
    def __init__(self, host, port, user, password, database):
        self.connection = psycopg2.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database
        )

    # General methods for executing queries

    def execute(self, query, data):
        cursor = self.connection.cursor()
        cursor.execute(query, data)
        self.connection.commit()
        cursor.close()

    def fetchall(self, query, data):
        cursor = self.connection.cursor()
        cursor.execute(query, data)
        result = cursor.fetchall()
        cursor.close()
        return result

    def fetchone(self, query, data):
        cursor = self.connection.cursor()
        cursor.execute(query, data)
        result = cursor.fetchone()
        cursor.close()
        return result

    # MeshInfo specific methods for interacting with the database
    # TODO: We might consider moving these to a separate class later
